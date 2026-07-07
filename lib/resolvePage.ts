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
  type PageRow,
} from "./store";

/**
 * What a resolved address renders as. `ok`/`taken_down` mirror the stored row;
 * `explore` is a render-only state (no row persisted) — a generation/moderation
 * failure, or admission control refusing generation (spend cap / rate limit,
 * §10). `text` is the page content or the relevant placeholder copy.
 */
export type ResolvedStatus = "ok" | "taken_down" | "explore";

export interface ResolvedPage {
  status: ResolvedStatus;
  text: string;
}

const TAKEN_DOWN_PLACEHOLDER =
  "This leaf has been removed from the library.";

const EXPLORE_ONLY_PLACEHOLDER =
  "This corner of the library is still dark — wander elsewhere and return later.";

/**
 * Resolve the page at a canonical address — the heart of the system
 * (docs/architecture.md §2): lookup → reserve → generate → moderate → commit.
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
  // address stays un-crystallized (it can generate after the cap resets) and
  // render explore-only rather than a real page.
  const admission = await checkAdmission(ctx);
  if (!admission.ok) {
    await releaseReservation(address);
    return { status: "explore", text: EXPLORE_ONLY_PLACEHOLDER };
  }
  // Count this generation before running it, so failures still throttle crawlers.
  await noteGeneration(ctx);

  try {
    const { content, provenance, usage } = await generatePipeline(address);
    await commitPage(address, content, provenance);
    await recordSpend(usage);
    return { status: "ok", text: content };
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
  if (row.status === "ok") return { status: "ok", text: row.content ?? "" };
  // taken_down is the only remaining non-ok terminal state.
  return { status: "taken_down", text: TAKEN_DOWN_PLACEHOLDER };
}
