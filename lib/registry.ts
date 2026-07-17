import { query } from "./db";
import { devLog } from "./log";
import { type ModelStat } from "./modelStats";
import { monitor } from "./monitor";
import { providerAvailable, type Provider } from "./providers";

/**
 * The model pool registry (docs/reference/architecture.md §6/§7, model-pool rework).
 * `model_registry` (lib/schema.sql) is keyed `(slug, task)` — the same model
 * can hold opposite-settings rows for `generation` (temp 0.9, weighted
 * lottery, variety is the point) and `moderation` (temp 0, fixed chain, no
 * variety at all). This module owns every read and every health mutation of
 * that table; lib/generate.ts and lib/moderate.ts never touch it directly.
 */

export type Task = "generation" | "moderation";
export type Health = "ok" | "cooling" | "unavailable";

export interface RegistryRow {
  slug: string;
  provider: Provider;
  task: Task;
  weight: number;
  order: number;
  temperature: number;
  maxTokens: number;
}

interface RegistryDbRow {
  slug: string;
  provider: Provider;
  task: Task;
  weight: number;
  order: number;
  temperature: number;
  max_tokens: number;
}

function fromDbRow(row: RegistryDbRow): RegistryRow {
  return {
    slug: row.slug,
    provider: row.provider,
    task: row.task,
    weight: row.weight,
    order: row.order,
    temperature: row.temperature,
    maxTokens: row.max_tokens,
  };
}

/**
 * Enabled rows for a task whose provider key is configured and whose health
 * currently permits selection: `ok`, or `cooling` whose window has already
 * passed — lazy recovery, no probe cron; the next real request just tries
 * again (extending the cooldown if it 429s again). `unavailable` rows never
 * come back (a 404 is permanent) and are always excluded.
 */
export async function poolFor(task: Task): Promise<RegistryRow[]> {
  const rows = await query<RegistryDbRow>(
    `SELECT slug, provider, task, weight, "order", temperature, max_tokens
     FROM model_registry
     WHERE task = $1
       AND enabled = true
       AND health <> 'unavailable'
       AND (health <> 'cooling' OR cooling_until <= now())`,
    [task],
  );
  return rows.map(fromDbRow).filter((row) => providerAvailable(row.provider));
}

/** Neutral latency assumption for a model with no model_stats samples yet. */
const REF_MS = 5000;
/**
 * Bounds on the latency tiebreak's effect on a row's configured weight —
 * keeps the fastest model from eating the pool. Variety is the point; the
 * configured weights are the primary signal, latency only nudges within them.
 */
const MIN_LATENCY_FACTOR = 0.8;
const MAX_LATENCY_FACTOR = 1.25;

/**
 * Weighted lottery over `rows` by `weight`, with observed avgMs (model_stats)
 * as a bounded tiebreak — `effectiveWeight = weight × clamp(REF_MS / avgMs,
 * 0.8, 1.25)`. A model with no samples yet gets factor 1 (no bias either
 * way). Pure and exported so the weight distribution is unit-testable without
 * a DB. Every row is assumed already eligible (poolFor's job) — this only
 * decides which one wins.
 */
export function weightedPick(
  rows: readonly RegistryRow[],
  stats: ReadonlyMap<string, ModelStat>,
): RegistryRow {
  if (rows.length === 0) {
    throw new Error("weightedPick: empty pool");
  }
  const effectiveWeights = rows.map((row) => {
    const avgMs = stats.get(row.slug)?.avgMs;
    const factor = avgMs
      ? Math.min(MAX_LATENCY_FACTOR, Math.max(MIN_LATENCY_FACTOR, REF_MS / avgMs))
      : 1;
    return Math.max(0, row.weight) * factor;
  });
  const total = effectiveWeights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // Every eligible row is weighted 0 — fall back to a uniform pick rather
    // than throw, so a config oddity degrades to "any model" instead of a
    // hard failure.
    return rows[Math.floor(Math.random() * rows.length)];
  }
  let r = Math.random() * total;
  for (let i = 0; i < rows.length; i++) {
    r -= effectiveWeights[i];
    if (r <= 0) return rows[i];
  }
  return rows[rows.length - 1]; // floating-point rounding fallback
}

/**
 * Pick one generation model: a weighted lottery over the eligible pool
 * (lib/generate.ts's entry point). Throws if nothing is eligible — this only
 * gates the expensive generate path (a novel address), never a cache hit, so
 * it's safe for resolvePage to let this propagate and release the reservation
 * for a later retry, same as any other generation failure.
 */
export async function chooseGenerationModel(
  stats: ReadonlyMap<string, ModelStat>,
): Promise<RegistryRow> {
  const rows = await poolFor("generation");
  const eligible = rows.filter((row) => row.weight > 0);
  const pool = eligible.length > 0 ? eligible : rows;
  if (pool.length === 0) {
    throw new Error(
      "chooseGenerationModel: no eligible generation models (check model_registry, provider keys, and health)",
    );
  }
  return weightedPick(pool, stats);
}

/** The moderation pool in chain order (lib/moderate.ts walks it in order). */
export async function moderationChain(): Promise<RegistryRow[]> {
  const rows = await poolFor("moderation");
  return [...rows].sort((a, b) => a.order - b.order);
}

/**
 * Park a model (for one task) so selection skips it until `until` passes — a
 * 429 that will come back (docs/reference/architecture.md §7). Non-throwing: a
 * registry-table hiccup must never break or slow a real generation/moderation
 * call, same posture as lib/modelStats.ts.
 */
export async function markCooling(slug: string, task: Task, until: Date): Promise<void> {
  try {
    await query(
      `UPDATE model_registry SET health = 'cooling', cooling_until = $3
       WHERE slug = $1 AND task = $2`,
      [slug, task, until],
    );
  } catch (err) {
    devLog(
      `registry: markCooling(${slug}, ${task}) failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Remove a model (for one task) from selection permanently — a 404, not
 * coming back. Disables the row outright (belt-and-suspenders alongside the
 * `health` filter in poolFor) and emits a `model_unavailable` monitor event
 * for a human to notice and eventually clean up the registry row.
 */
export async function markUnavailable(slug: string, task: Task): Promise<void> {
  try {
    const rows = await query<{ provider: Provider }>(
      `UPDATE model_registry SET health = 'unavailable', enabled = false
       WHERE slug = $1 AND task = $2
       RETURNING provider`,
      [slug, task],
    );
    await monitor("model_unavailable", { slug, task, provider: rows[0]?.provider });
  } catch (err) {
    devLog(
      `registry: markUnavailable(${slug}, ${task}) failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Reset a recovered `cooling` row back to `ok` on a successful call, so a
 * model that answers again doesn't keep getting treated as merely
 * "not-yet-expired-cooldown" by anything reading `health` directly. Not
 * required for selection itself — poolFor's cooling_until check already
 * re-admits it lazily — this just keeps the stored `health` value honest.
 * No-op (and non-throwing) if the row wasn't cooling.
 */
export async function markHealthy(slug: string, task: Task): Promise<void> {
  try {
    await query(
      `UPDATE model_registry SET health = 'ok', cooling_until = NULL
       WHERE slug = $1 AND task = $2 AND health = 'cooling'`,
      [slug, task],
    );
  } catch (err) {
    devLog(
      `registry: markHealthy(${slug}, ${task}) failed (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
