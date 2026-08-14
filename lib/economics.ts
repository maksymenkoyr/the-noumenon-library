import { config } from "./config";
import { query } from "./db";
import { ipHash } from "./ipHash";
import { devLog } from "./log";
import { monitor } from "./monitor";

/**
 * Economics & safety controls — admission control and the spend counter
 * (docs/reference/architecture.md §10, docs/reference/economics.md). The counter store is Postgres
 * (§10: "fine at this scale"); this module owns the two counter tables
 * (rate_limit_hits, monthly_spend — lib/schema.sql) and nothing page-related.
 *
 * Called from resolvePage's generateAndCommit — the single choke point every
 * real generation passes, after the store lookup and before the LLM call. Cache
 * hits never reach here, so revisits stay free of rate-limit and cost accounting.
 */

/** Per-request context threaded from the app layer (lib/clientIp.ts). */
export interface AdmissionContext {
  clientIp?: string;
}

export type AdmissionResult =
  | { ok: true }
  | { ok: false; reason: "rate_limit" | "spend_cap" };

/** Token/cost accounting for one page's generation (summed across retries). */
export interface GenerationUsage {
  tokens: number;
  costUsd: number;
}

/** Current calendar month in UTC, the monthly_spend primary key. */
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

/** Running spend for the current month (0 if no row yet). */
async function monthlySpendUsd(): Promise<number> {
  const rows = await query<{ cost_usd: string }>(
    "SELECT cost_usd FROM monthly_spend WHERE month = $1",
    [currentMonth()],
    "economics.monthlySpendUsd",
  );
  return Number(rows[0]?.cost_usd ?? 0);
}

/** Generations by this IP within the given sliding window (seconds). */
async function recentGenerationCount(
  hash: string,
  windowSeconds: number,
): Promise<number> {
  const rows = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM rate_limit_hits
     WHERE ip_hash = $1 AND created_at > now() - make_interval(secs => $2)`,
    [hash, windowSeconds],
    "economics.recentGenerationCount",
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Gate a would-be generation: global spend cap first (cheapest, one row), then
 * the per-visitor rate limit — only when we can identify the caller (no IP → no
 * rate limit rather than keying every anonymous hit together). Two tiers share
 * the one rate_limit_hits counter: a tight per-minute ceiling and a looser
 * per-hour one, so pacing just under the minute limit doesn't escape entirely.
 * Read-only; the hit is recorded separately by noteGeneration once the
 * generation is admitted.
 */
export async function checkAdmission(
  ctx: AdmissionContext,
): Promise<AdmissionResult> {
  const spendUsd = await monthlySpendUsd();
  if (spendUsd >= config.monthlySpendCapUsd) {
    // Was devLog-only, a no-op in production (lib/log.ts gates on
    // config.devMode) — the cap could trip in prod and the operator would
    // never know beyond every visitor seeing the "explore-only" placeholder.
    // monitor()'s own 60s per-event throttle (lib/monitor.ts) keeps this from
    // flooding while the cap stays tripped for the rest of the month.
    await monitor("spend_cap_reached", {
      spendUsd,
      capUsd: config.monthlySpendCapUsd,
    });
    return { ok: false, reason: "spend_cap" };
  }

  if (ctx.clientIp) {
    const hash = ipHash(ctx.clientIp);
    const minuteCount = await recentGenerationCount(
      hash,
      config.rateLimitWindowSeconds,
    );
    if (minuteCount >= config.rateLimitPerMinute) {
      devLog(`admission: rate limit hit (${minuteCount}/min) → rate-limited`);
      await monitor("rate_limit_tripped", { tier: "minute", count: minuteCount });
      return { ok: false, reason: "rate_limit" };
    }
    const hourCount = await recentGenerationCount(
      hash,
      config.rateLimitHourWindowSeconds,
    );
    if (hourCount >= config.rateLimitPerHour) {
      devLog(`admission: rate limit hit (${hourCount}/hr) → rate-limited`);
      await monitor("rate_limit_tripped", { tier: "hour", count: hourCount });
      return { ok: false, reason: "rate_limit" };
    }
  }

  return { ok: true };
}

/**
 * Record that an admitted generation is proceeding. Called for every generation
 * we let through — including ones that later fail moderation — so a crawler
 * hammering dead addresses still counts against its limit. Prunes rows outside
 * the *longest* window opportunistically so nothing is retained long-term
 * (§12) while still leaving enough history for the hourly tier to count.
 */
export async function noteGeneration(ctx: AdmissionContext): Promise<void> {
  if (!ctx.clientIp) return;
  const hash = ipHash(ctx.clientIp);
  const retentionSeconds = Math.max(
    config.rateLimitWindowSeconds,
    config.rateLimitHourWindowSeconds,
  );
  await query(
    "INSERT INTO rate_limit_hits (ip_hash) VALUES ($1)",
    [hash],
    "economics.noteGeneration.recordHit",
  );
  await query(
    `DELETE FROM rate_limit_hits
     WHERE ip_hash = $1 AND created_at < now() - make_interval(secs => $2)`,
    [hash, retentionSeconds],
    "economics.noteGeneration.prune",
  );
}

/**
 * Increment the monthly spend counter after a successful generation
 * (tokens and tokens×price). Atomic upsert so concurrent generations accumulate.
 */
export async function recordSpend(usage: GenerationUsage): Promise<void> {
  const month = currentMonth();
  const rows = await query<{ cost_usd: string }>(
    `INSERT INTO monthly_spend (month, tokens, cost_usd)
     VALUES ($1, $2, $3)
     ON CONFLICT (month) DO UPDATE SET
       tokens = monthly_spend.tokens + EXCLUDED.tokens,
       cost_usd = monthly_spend.cost_usd + EXCLUDED.cost_usd
     RETURNING cost_usd`,
    [month, usage.tokens, usage.costUsd],
    "economics.recordSpend",
  );
  await maybeAlertSpendThreshold(month, Number(rows[0]?.cost_usd ?? 0));
}

/** Percent-of-cap thresholds worth a heads-up before the cap actually trips. */
const SPEND_ALERT_THRESHOLDS = [50, 80, 100] as const;

/**
 * Fire a one-time alert the first time this month's spend crosses each
 * threshold in SPEND_ALERT_THRESHOLDS. `monthly_spend.alerted_pct` is an
 * idempotency marker, not a counter (lib/schema.sql): the
 * `WHERE alerted_pct < $2` claim is the same atomic-claim idiom used for page
 * reservation (pages.status) and report resolution, so a burst of concurrent
 * generations crossing 50% together still fires exactly one alert rather than
 * one per request racing here.
 */
async function maybeAlertSpendThreshold(
  month: string,
  spendUsd: number,
): Promise<void> {
  const pctReached = Math.floor((spendUsd / config.monthlySpendCapUsd) * 100);
  const threshold = [...SPEND_ALERT_THRESHOLDS]
    .reverse()
    .find((t) => pctReached >= t);
  if (threshold === undefined) return;

  const claimed = await query(
    `UPDATE monthly_spend SET alerted_pct = $2
     WHERE month = $1 AND alerted_pct < $2
     RETURNING alerted_pct`,
    [month, threshold],
    "economics.maybeAlertSpendThreshold",
  );
  // Empty result means another concurrent call already claimed this
  // threshold (or a higher one) first — nothing more to do.
  if (claimed.length === 0) return;

  await monitor("spend_threshold_reached", {
    pct: threshold,
    spendUsd,
    capUsd: config.monthlySpendCapUsd,
  });
}
