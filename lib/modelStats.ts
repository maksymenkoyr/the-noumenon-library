import { query } from "./db";
import { devLog } from "./log";

/**
 * Per-model performance telemetry (lib/schema.sql `model_stats`,
 * docs/architecture.md §6/§10). Fed by both lib/generate.ts and lib/moderate.ts
 * so free-vs-paid selection is data-driven: average latency down-weights slow
 * free models, and a rate-limit cooldown parks a model that just errored.
 *
 * The account-wide OpenRouter `free-models-per-day` cap 429s every `:free`
 * model at once, so it gets its own sentinel row (FREE_TIER_KEY) rather than
 * being attributed to whichever model happened to be mid-flight.
 *
 * Every export here is deliberately non-throwing: telemetry must never break
 * or slow a real generation/moderation call. Callers invoke these
 * fire-and-forget (`void recordModelCall(...)`).
 */

export const FREE_TIER_KEY = "__free_tier__";

export interface ModelStat {
  avgMs: number | undefined; // undefined = no samples yet
  rateLimitedUntil: Date | undefined;
}

/** Record one completed call's outcome. Fire-and-forget; never throws. */
export async function recordModelCall(
  model: string,
  outcome: { ms: number; ok: boolean },
): Promise<void> {
  try {
    await query(
      `INSERT INTO model_stats (model, calls, total_ms, errors, last_used_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (model) DO UPDATE SET
         calls = model_stats.calls + EXCLUDED.calls,
         total_ms = model_stats.total_ms + EXCLUDED.total_ms,
         errors = model_stats.errors + EXCLUDED.errors,
         last_used_at = now()`,
      [model, outcome.ok ? 1 : 0, outcome.ok ? Math.round(outcome.ms) : 0, outcome.ok ? 0 : 1],
    );
  } catch (err) {
    devLog(
      `modelStats: recordModelCall(${model}) failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Park a model (or the FREE_TIER_KEY sentinel) so selection skips it until
 * the cooldown expires. Fire-and-forget; never throws.
 */
export async function markRateLimited(model: string, seconds: number): Promise<void> {
  try {
    await query(
      `INSERT INTO model_stats (model, rate_limited_until, last_used_at)
       VALUES ($1, now() + make_interval(secs => $2), now())
       ON CONFLICT (model) DO UPDATE SET
         rate_limited_until = now() + make_interval(secs => $2),
         last_used_at = now()`,
      [model, seconds],
    );
  } catch (err) {
    devLog(
      `modelStats: markRateLimited(${model}) failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Snapshot of every model's stats, keyed by model id (plus FREE_TIER_KEY).
 * Read-only, used by selection; a DB failure here degrades to "no stats
 * known" (empty map) rather than failing the request.
 */
export async function getModelStats(): Promise<Map<string, ModelStat>> {
  try {
    const rows = await query<{
      model: string;
      calls: string;
      total_ms: string;
      rate_limited_until: Date | null;
    }>(`SELECT model, calls, total_ms, rate_limited_until FROM model_stats`);

    const stats = new Map<string, ModelStat>();
    for (const row of rows) {
      const calls = Number(row.calls);
      stats.set(row.model, {
        avgMs: calls > 0 ? Number(row.total_ms) / calls : undefined,
        rateLimitedUntil: row.rate_limited_until ?? undefined,
      });
    }
    return stats;
  } catch (err) {
    devLog(
      "modelStats: getModelStats failed (non-fatal, treating as no stats):",
      err instanceof Error ? err.message : String(err),
    );
    return new Map();
  }
}

/** Whether a stat entry's cooldown is currently active. */
function onCooldown(stat: ModelStat | undefined): boolean {
  return !!stat?.rateLimitedUntil && stat.rateLimitedUntil.getTime() > Date.now();
}

/** Whether the account-wide free-tier cap is currently in cooldown. */
export function freeTierOnCooldown(stats: Map<string, ModelStat>): boolean {
  return onCooldown(stats.get(FREE_TIER_KEY));
}

/** Whether a specific model's own per-model cooldown is currently active. */
export function modelOnCooldown(stats: Map<string, ModelStat>, model: string): boolean {
  return onCooldown(stats.get(model));
}
