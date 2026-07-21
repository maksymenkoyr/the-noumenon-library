import {
  checkAdmission,
  noteGeneration,
  recordSpend,
  type AdmissionContext,
} from "./economics";
import { monitor } from "./monitor";
import { generatePipeline } from "./pipeline";
import {
  commitPage,
  getPage,
  reclaimStaleReservation,
  releaseReservation,
  reservePage,
  waitForPage,
  type PageInputs,
  type PageRow,
} from "./store";

/**
 * What a resolved address renders as. `ok`/`taken_down` mirror the stored row;
 * `explore` and `rate_limited` are both render-only states (no row persisted)
 * from admission control refusing generation (§10): `explore` for the global
 * spend cap (not this visitor's fault, so the copy points them onward)
 * and `rate_limited` for this visitor's own per-IP ceiling (minute or hour
 * tier, lib/economics.ts) — kept distinct so the reader gets a message about
 * their own pace rather than the generic "still dark" copy. A bare generation/
 * moderation failure also renders as `explore`. `text` is the page content or
 * the relevant placeholder copy.
 */
export type ResolvedStatus = "ok" | "taken_down" | "explore" | "rate_limited";

export interface ResolvedPage {
  status: ResolvedStatus;
  text: string;
  // Dev-overlay provenance (lib/devMode, app/[[...address]]/dev-badge), ignored
  // by non-dev callers. Sourced from the stored PageInputs record (lib/store.ts)
  // on both a fresh generation and a committed revisit alike; only undefined
  // for rows committed before pages.inputs existed, which degrade to a
  // model-only badge (see `devFields` below).
  model?: string;
  generationMs?: number;
  moderationMs?: number;
  // The chain link that passed the committed content (lib/moderate.ts).
  moderationModel?: string;
  // The exact prompt sent for this generation, plus the levers that produced
  // it — fresh-generation only. The prompt is never persisted, so a revisit
  // has no way to reconstruct the original; the overlay simply omits it
  // rather than showing something approximate.
  prompt?: string;
  promptVariant?: string;
  temperature?: number;
}

/**
 * Dev-overlay fields from a stored/just-built inputs record. Falls back to
 * the scalar model column for rows committed before pages.inputs existed
 * (NULL inputs → model-only badge).
 */
export function devFields(
  inputs: PageInputs | null | undefined,
  fallbackModel?: string | null,
): Pick<
  ResolvedPage,
  | "model"
  | "generationMs"
  | "moderationMs"
  | "moderationModel"
  | "prompt"
  | "promptVariant"
  | "temperature"
> {
  if (!inputs) return { model: fallbackModel ?? undefined };
  return {
    model: inputs.model ?? fallbackModel ?? undefined,
    generationMs: inputs.generationMs,
    moderationMs: inputs.moderationMs,
    moderationModel: inputs.moderationModel,
    prompt: inputs.prompt,
    promptVariant: inputs.promptVariant,
    temperature: inputs.temperature,
  };
}

const TAKEN_DOWN_PLACEHOLDER =
  "This page has been removed from the library.";

const EXPLORE_ONLY_PLACEHOLDER =
  "This corner of the library is still dark — wander elsewhere and return later.";

const RATE_LIMITED_PLACEHOLDER =
  "You're wandering faster than the library can crystallize new pages. Pause a moment, then return.";

/**
 * Resolve the page at a canonical address — the heart of the system
 * (docs/reference/architecture.md §2): lookup → reserve → generate → moderate → commit.
 * Generate-once, store-forever: revisits never touch the LLM, and N concurrent
 * first-visitors trigger exactly one generation (§3).
 *
 * Callable from both a server component and a route handler.
 *
 * @param address - canonical normalized address (lib/address.ts).
 * @param ctx - request context for admission control (client IP for the rate
 *   limit); defaults to empty for non-request callers (tests, scripts).
 */
export async function resolvePage(
  address: string,
  ctx: AdmissionContext = {},
): Promise<ResolvedPage> {
  const existing = await getPage(address);
  if (existing) {
    if (existing.status !== "generating") return resolved(existing);
    return waitOrReclaim(address, ctx);
  }

  if (await reservePage(address)) return generateAndCommit(address, ctx);
  // Lost the reservation race — another request owns generation.
  return waitOrReclaim(address, ctx);
}

/** Another request is (or was) generating: wait for it, reclaim if stale. */
async function waitOrReclaim(
  address: string,
  ctx: AdmissionContext,
): Promise<ResolvedPage> {
  if (await reclaimStaleReservation(address)) {
    return generateAndCommit(address, ctx);
  }
  const row = await waitForPage(address);
  if (row && row.status !== "generating") return resolved(row);
  if (row === null) {
    // Winner released its reservation (failed generation) — take over.
    if (await reservePage(address)) return generateAndCommit(address, ctx);
  }
  if (await reclaimStaleReservation(address)) {
    return generateAndCommit(address, ctx);
  }
  throw new Error(`Timed out waiting for generation of ${address}`);
}

async function generateAndCommit(
  address: string,
  ctx: AdmissionContext,
): Promise<ResolvedPage> {
  // Admission control (§10, §2 step 4): gate the expensive path only. Over the
  // spend cap or this visitor's rate limit → release the reservation so the
  // address stays un-crystallized (it can generate after the cap/window
  // resets) and render a placeholder rather than a real page. The two
  // reasons get distinct copy: a rate limit is about this visitor's own
  // pace (rate_limited), while the spend cap is a global condition with
  // nothing they can do differently (explore).
  const admission = await checkAdmission(ctx);
  if (!admission.ok) {
    await releaseReservation(address);
    if (admission.reason === "rate_limit") {
      return { status: "rate_limited", text: RATE_LIMITED_PLACEHOLDER };
    }
    return { status: "explore", text: EXPLORE_ONLY_PLACEHOLDER };
  }
  // Count this generation before running it, so failures still throttle crawlers.
  await noteGeneration(ctx);

  try {
    const { content, inputs, usage } = await generatePipeline(address);
    if (!(await commitPage(address, content, inputs))) {
      // The reservation is gone or no longer 'generating' — a takedown landed
      // mid-generation (which must win, docs/reference/legal.md), or the row was
      // released/reclaimed by another request. The LLM spend still happened,
      // so record it, then serve whatever the store holds now rather than
      // presenting the orphaned content as committed.
      await recordSpend(usage);
      await monitor("commit_lost", { address });
      const row = await getPage(address);
      if (row && row.status !== "generating") return resolved(row);
      return { status: "explore", text: EXPLORE_ONLY_PLACEHOLDER };
    }
    await recordSpend(usage);
    return { status: "ok", text: content, ...devFields(inputs) };
  } catch (error) {
    // Unwedge the address so the next visitor becomes the first visitor. Covers
    // provider errors, an undetermined moderation result (lib/moderate throws),
    // and content that failed moderation twice (lib/pipeline throws) — all are
    // retried on a later visit rather than permanently blocked.
    await releaseReservation(address);
    // Emit an observability event (§9 error logging/alerting) before rethrowing.
    await monitor("generation_failed", {
      address,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function resolved(row: PageRow): ResolvedPage {
  // Revisit: the stored inputs record (if present) surfaces the same
  // prompt/levers/timings a fresh generation would; old rows with no
  // stored inputs degrade to a model-only badge (devFields).
  if (row.status === "ok")
    return { status: "ok", text: row.content ?? "", ...devFields(row.inputs, row.model) };
  // taken_down is the only remaining non-ok terminal state.
  return { status: "taken_down", text: TAKEN_DOWN_PLACEHOLDER };
}
