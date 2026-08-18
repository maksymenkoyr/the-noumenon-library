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
 *
 * The spend cap is enforced by *reservation*, not by reading the running total
 * (a launch-blocker fix, §1.4): a generation call runs 8-32s, and the old
 * "read the total, generate, then write the total" sequence left that whole
 * window where concurrent requests to *different* addresses all read the same
 * under-cap total and were all admitted — overshoot bounded only by
 * concurrency × per-page cost, not by the cap. checkAdmission now atomically
 * claims a conservative cost estimate against the cap in the same statement
 * that checks it (reserveSpend), so concurrent claims serialize on that one
 * Postgres row instead of racing a stale read. Every successful admission
 * MUST be settled exactly once — reconcileSpend (a generation ran, success or
 * commit-lost) or refundSpend (admission was reversed, or generation never
 * ran) — or the reservation permanently inflates the counter.
 */

/** Per-request context threaded from the app layer (lib/clientIp.ts). */
export interface AdmissionContext {
  clientIp?: string;
}

export type AdmissionResult =
  | { ok: true; reservedUsd: number }
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

/**
 * Worst-case cost of one full generatePipeline() run (lib/pipeline.ts): up to
 * three generation calls — the initial attempt, one moderation-reject regen,
 * one dedup regen — each capped at the model_registry generation ceiling
 * (max_tokens: 1000, lib/schema.sql seed rows), priced at the most expensive
 * currently configured model regardless of its lottery weight. Deliberately
 * an overestimate: it is reserved before generation starts and trued up to
 * the real cost immediately after (reconcileSpend), so overshooting it only
 * shrinks the cap's headroom for the ~8-32s a generation is in flight — it
 * never wastes real budget.
 */
const MAX_ATTEMPTS_PER_GENERATION = 3;
const MAX_TOKENS_PER_CALL = 1000;

function estimatedGenerationCostUsd(): number {
  const maxPricePerMillion = Math.max(0, ...Object.values(config.modelPrices));
  return (
    MAX_ATTEMPTS_PER_GENERATION *
    (MAX_TOKENS_PER_CALL / 1_000_000) *
    maxPricePerMillion
  );
}

/**
 * Atomically claim `estimateUsd` against the monthly cap: a single
 * conditional upsert that only applies if the reservation keeps the running
 * total at or under the cap, so concurrent claims serialize on this one row
 * in Postgres itself rather than each reading a stale total. Mirrors the
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE` idempotency-claim idiom
 * maybeAlertSpendThreshold already uses below.
 */
async function reserveSpend(
  estimateUsd: number,
): Promise<{ ok: true } | { ok: false; spendUsd: number }> {
  const month = currentMonth();
  const claimed = await query<{ cost_usd: string }>(
    `INSERT INTO monthly_spend (month, tokens, cost_usd)
     VALUES ($1, 0, $2)
     ON CONFLICT (month) DO UPDATE SET
       cost_usd = monthly_spend.cost_usd + EXCLUDED.cost_usd
     WHERE monthly_spend.cost_usd + $2 <= $3
     RETURNING cost_usd`,
    [month, estimateUsd, config.monthlySpendCapUsd],
    "economics.reserveSpend",
  );
  if (claimed.length > 0) return { ok: true };
  // Claim failed — informational only (monitor payload), not part of the
  // admission decision, so a concurrent claim landing between these two
  // queries can't reopen the race this function exists to close.
  return { ok: false, spendUsd: await monthlySpendUsd() };
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
 * Gate a would-be generation: global spend cap first (claimed atomically, so
 * it's also the cheapest way to fail fast under a burst), then the
 * per-visitor rate limit — only when we can identify the caller (no IP → no
 * rate limit rather than keying every anonymous hit together). Two tiers
 * share the one rate_limit_hits counter: a tight per-minute ceiling and a
 * looser per-hour one, so pacing just under the minute limit doesn't escape
 * entirely.
 *
 * Not read-only: an `ok: true` result has already reserved `reservedUsd`
 * against the cap (reserveSpend) as a side effect. The caller must settle it
 * exactly once — reconcileSpend once generation runs, or refundSpend if
 * admission is reversed for any other reason (as the rate-limit checks below
 * do) or generation never happens. The hit itself is recorded separately by
 * noteGeneration once the generation is admitted.
 */
export async function checkAdmission(
  ctx: AdmissionContext,
): Promise<AdmissionResult> {
  const estimateUsd = estimatedGenerationCostUsd();
  const reservation = await reserveSpend(estimateUsd);
  if (!reservation.ok) {
    // Was devLog-only, a no-op in production (lib/log.ts gates on
    // config.devMode) — the cap could trip in prod and the operator would
    // never know beyond every visitor seeing the "explore-only" placeholder.
    // monitor()'s own 60s per-event throttle (lib/monitor.ts) keeps this from
    // flooding while the cap stays tripped for the rest of the month.
    await monitor("spend_cap_reached", {
      spendUsd: reservation.spendUsd,
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
      await refundSpend(estimateUsd);
      devLog(`admission: rate limit hit (${minuteCount}/min) → rate-limited`);
      await monitor("rate_limit_tripped", { tier: "minute", count: minuteCount });
      return { ok: false, reason: "rate_limit" };
    }
    const hourCount = await recentGenerationCount(
      hash,
      config.rateLimitHourWindowSeconds,
    );
    if (hourCount >= config.rateLimitPerHour) {
      await refundSpend(estimateUsd);
      devLog(`admission: rate limit hit (${hourCount}/hr) → rate-limited`);
      await monitor("rate_limit_tripped", { tier: "hour", count: hourCount });
      return { ok: false, reason: "rate_limit" };
    }
  }

  return { ok: true, reservedUsd: estimateUsd };
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
 * Reverse a reservation that reserveSpend claimed but that never turned into
 * (or didn't fully turn into) real spend — a rate-limit trip after admission,
 * or a generation that threw before committing. A plain negative-cost delta
 * through recordSpend; touches no tokens, since none were reserved.
 *
 * Note: a thrown pipeline error may still represent real, uncounted spend —
 * lib/pipeline.ts accumulates usage across retries locally and does not
 * surface it on throw (e.g. two moderation rejects, each a real paid call),
 * a pre-existing gap this refund doesn't fix. Refunding the full estimate
 * here keeps that blind spot from compounding into a stuck phantom
 * reservation on top of it.
 */
export async function refundSpend(estimateUsd: number): Promise<void> {
  await recordSpend({ tokens: 0, costUsd: -estimateUsd });
}

/**
 * True up a claimed reservation to a generation's real cost once it's known
 * (called for both a committed page and a commit-lost one — the LLM spend
 * happened either way). `usage.tokens` is added in full (the reservation
 * itself never touches tokens); the estimate is backed out of `costUsd` so
 * the counter converges to actual spend rather than the conservative
 * estimate reserveSpend claimed. The delta is usually negative, since the
 * estimate assumes the worst-case model and attempt count.
 */
export async function reconcileSpend(
  reservedUsd: number,
  usage: GenerationUsage,
): Promise<void> {
  await recordSpend({
    tokens: usage.tokens,
    costUsd: usage.costUsd - reservedUsd,
  });
}

/**
 * Increment the monthly spend counter (tokens and tokens×price, which may be
 * a reconciling delta rather than a fresh cost — see reconcileSpend/
 * refundSpend above). Atomic upsert so concurrent callers accumulate.
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
