// Daily model-pool review (docs/reference/architecture.md §6).
//
// Reads the pool, the providers' live catalogs, OpenRouter's usage rankings,
// and our own reader signals; applies the safe corrections itself; records
// everything else as a proposal for /operator; and pushes one digest to
// Telegram. See lib/modelReview.ts for the decision rules — all of them live
// there, pure and unit-tested. This file is only plumbing.
//
// Usage:
//   npm run models:review              apply + record + notify
//   npm run models:review -- --dry-run read-only; prints the digest, writes nothing
//
// This is a .ts script run directly by Node's native type stripping (node >=
// 22.18; CI pins 24), with no build step — which is what lets it share the
// reviewed, typechecked, unit-tested modules in lib/ instead of keeping a
// second copy of the rules in plain JS. That is also why the lib/ imports below
// carry explicit .ts extensions: Node's ESM resolver has no extensionless
// lookup, and tsconfig's allowImportingTsExtensions exists for exactly this.
import { randomUUID } from "node:crypto";
import pg from "pg";

import {
  fetchGoogleCatalog,
  fetchOpenRouterCatalog,
  fetchOpenRouterRankings,
  type CatalogModel,
  type CatalogProvider,
} from "../lib/modelCatalog.ts";
import {
  formatDigest,
  reviewPool,
  type ModelSignal,
  type PoolRow,
} from "../lib/modelReview.ts";

const dryRun = process.argv.includes("--dry-run");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
const telegramChat = process.env.TELEGRAM_CHAT_ID ?? "";
const dashboardUrl = process.env.OPERATOR_DASHBOARD_URL ?? "";

/**
 * Push one message. Best-effort in the same spirit as lib/monitor.ts: a down
 * Telegram must not fail a run that already did its work correctly. The one
 * thing it must not do is fail *silently*, so a delivery problem still prints.
 */
async function notify(text: string): Promise<void> {
  if (!telegramToken || !telegramChat) {
    console.log("(no Telegram credentials — digest printed above only)");
    return;
  }
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${telegramToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramChat,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok) {
      console.error(`Telegram sendMessage → HTTP ${response.status}`);
    }
  } catch (err) {
    console.error("Telegram push failed:", err instanceof Error ? err.message : err);
  }
}

interface PoolDbRow {
  slug: string;
  provider: CatalogProvider;
  task: "generation" | "moderation";
  enabled: boolean;
  weight: number;
  order: number;
  health: string;
  price_per_million: string | null;
  baseline_price: string | null;
  expires_at: Date | null;
  trial: boolean;
}

/** NUMERIC comes off pg as a string (arbitrary precision); narrow it here. */
function numeric(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const client = new pg.Client({ connectionString: databaseUrl });

async function main(): Promise<void> {
  await client.connect();

  const poolResult = await client.query<PoolDbRow>(
    `SELECT slug, provider, task, enabled, weight, "order", health,
            price_per_million, baseline_price, expires_at, trial
       FROM model_registry`,
  );
  const pool: PoolRow[] = poolResult.rows.map((row) => ({
    slug: row.slug,
    provider: row.provider,
    task: row.task,
    enabled: row.enabled,
    weight: row.weight,
    order: row.order,
    health: row.health,
    pricePerMillion: numeric(row.price_per_million),
    baselinePrice: numeric(row.baseline_price),
    expiresAt: row.expires_at,
    trial: row.trial,
  }));

  const signalsResult = await client.query(
    `SELECT model, pages, likes, dislikes, visits, avg_median_dwell_ms
       FROM model_signals`,
  );
  const signals: ModelSignal[] = signalsResult.rows.map((row) => ({
    model: row.model,
    pages: Number(row.pages ?? 0),
    likes: Number(row.likes ?? 0),
    dislikes: Number(row.dislikes ?? 0),
    visits: Number(row.visits ?? 0),
    avgMedianDwellMs:
      row.avg_median_dwell_ms === null ? null : Number(row.avg_median_dwell_ms),
  }));

  // Catalogs are fetched independently and a failure is per-provider, not
  // fatal: lib/modelReview.ts is told which providers it actually heard from,
  // so an outage at one reads as "no information about those rows" instead of
  // "every one of those models is dead". Getting this wrong is how an
  // unattended job empties the pool.
  const catalog: CatalogModel[] = [];
  const cataloguedProviders: CatalogProvider[] = [];

  try {
    catalog.push(...(await fetchOpenRouterCatalog()));
    cataloguedProviders.push("openrouter");
  } catch (err) {
    console.error("OpenRouter catalog fetch failed:", err instanceof Error ? err.message : err);
  }

  const googleKey = process.env.GOOGLE_API_KEY ?? "";
  if (googleKey) {
    try {
      catalog.push(...(await fetchGoogleCatalog(googleKey)));
      cataloguedProviders.push("google");
    } catch (err) {
      console.error("Google catalog fetch failed:", err instanceof Error ? err.message : err);
    }
  }

  // Never throws — null just means no suggestions today.
  const rankings = await fetchOpenRouterRankings();

  // A run that heard from nobody has no basis for any decision. Stopping here
  // is the difference between "no news" and a pool-wide disable.
  if (cataloguedProviders.length === 0) {
    throw new Error("no provider catalog could be fetched — aborting without changes");
  }

  const now = new Date();
  const result = reviewPool({
    pool,
    catalog,
    rankings,
    signals,
    now,
    cataloguedProviders,
  });

  const digest = formatDigest(result, {
    date: now.toISOString().slice(0, 10),
    dashboardUrl: dashboardUrl || undefined,
    dryRun,
  });
  console.log(digest);

  if (dryRun) {
    console.log(
      `\n(dry run — ${result.autoActions.length} action(s) and ${result.proposals.length} proposal(s) NOT written)`,
    );
    return;
  }

  const runId = randomUUID();
  await client.query("BEGIN");
  try {
    for (const action of result.autoActions) {
      if (action.kind === "reprice") {
        // baseline_price is stamped on first sight only. COALESCE, not an
        // assignment: overwriting it every run would move the spike guard's
        // reference along with the price and make a slow climb undetectable.
        await client.query(
          `UPDATE model_registry
              SET price_per_million = $3,
                  price_checked_at  = now(),
                  baseline_price    = COALESCE(baseline_price, $3)
            WHERE slug = $1 AND task = $2`,
          [action.slug, action.task, action.price],
        );
      } else {
        await client.query(
          `UPDATE model_registry SET enabled = false WHERE slug = $1 AND task = $2`,
          [action.slug, action.task],
        );
      }
    }

    // Freshness stamp for every row we did see, priced or not, so "when was
    // this last confirmed to exist" is answerable independently of whether the
    // number moved.
    const seen = catalog.map((model) => `${model.provider}:${model.slug}`);
    await client.query(
      `UPDATE model_registry SET price_checked_at = now()
        WHERE provider || ':' || slug = ANY($1::text[])`,
      [seen],
    );

    // Last run's undecided proposals are stale the moment this one lands —
    // prices moved, ranks moved. Retire them rather than letting the dashboard
    // accumulate a pile of overlapping suggestions from different days.
    await client.query(
      `UPDATE model_proposals SET status = 'superseded', decided_at = now()
        WHERE status = 'pending'`,
    );

    for (const proposal of result.proposals) {
      await client.query(
        `INSERT INTO model_proposals (run_id, slug, provider, task, action, reason, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          runId,
          proposal.slug,
          proposal.provider,
          proposal.task,
          proposal.action,
          proposal.reason,
          JSON.stringify(proposal.payload),
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }

  console.log(
    `\nApplied ${result.autoActions.length} action(s); recorded ${result.proposals.length} proposal(s) as run ${runId}.`,
  );

  // Nothing happened and nothing is waiting — don't spend a notification on
  // it. A daily "no changes" ping is how an alert channel becomes background
  // noise, and then a real one gets scrolled past.
  if (result.autoActions.length === 0 && result.proposals.length === 0) {
    console.log("(no changes — digest not pushed)");
    return;
  }
  await notify(digest);
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Model review failed:", message);
  // A silent cron is a dead cron. The nightly backup failed unnoticed for
  // weeks because nothing shouted; this must not repeat.
  await notify(`⚠ Model pool review FAILED\n\n${message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
