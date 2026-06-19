import { generatePipeline } from "./pipeline";
import {
  commitPage,
  getPage,
  reclaimStaleReservation,
  releaseReservation,
  reservePage,
  waitForPage,
  type PageRow,
  type PageStatus,
} from "./store";

/**
 * What a resolved address renders as. `text` is the page content for `ok`, or
 * the placeholder copy for `taken_down`. `generating` never escapes —
 * resolvePage waits for a final state.
 */
export interface ResolvedPage {
  status: PageStatus;
  text: string;
}

const TAKEN_DOWN_PLACEHOLDER =
  "This leaf has been removed from the library.";

/**
 * Resolve the page at a canonical address — the heart of the system
 * (docs/architecture.md §2): lookup → reserve → generate → moderate → commit.
 * Generate-once, store-forever: revisits never touch the LLM, and N concurrent
 * first-visitors trigger exactly one generation (§3).
 *
 * Callable from both a server component and a route handler.
 *
 * @param address - canonical normalized address (lib/address.ts).
 */
export async function resolvePage(address: string): Promise<ResolvedPage> {
  const existing = await getPage(address);
  if (existing) {
    if (existing.status !== "generating") return resolved(existing);
    return waitOrReclaim(address);
  }

  if (await reservePage(address)) return generateAndCommit(address);
  // Lost the reservation race — another request owns generation.
  return waitOrReclaim(address);
}

/** Another request is (or was) generating: wait for it, reclaim if stale. */
async function waitOrReclaim(address: string): Promise<ResolvedPage> {
  if (await reclaimStaleReservation(address)) {
    return generateAndCommit(address);
  }
  const row = await waitForPage(address);
  if (row && row.status !== "generating") return resolved(row);
  if (row === null) {
    // Winner released its reservation (failed generation) — take over.
    if (await reservePage(address)) return generateAndCommit(address);
  }
  if (await reclaimStaleReservation(address)) {
    return generateAndCommit(address);
  }
  throw new Error(`Timed out waiting for generation of ${address}`);
}

async function generateAndCommit(address: string): Promise<ResolvedPage> {
  try {
    const { content, provenance } = await generatePipeline(address);
    await commitPage(address, content, provenance);
    return { status: "ok", text: content };
  } catch (error) {
    // Unwedge the address so the next visitor becomes the first visitor. Covers
    // provider errors, an undetermined moderation result (lib/moderate throws),
    // and content that failed moderation twice (lib/pipeline throws) — all are
    // retried on a later visit rather than permanently blocked.
    await releaseReservation(address);
    throw error;
  }
}

function resolved(row: PageRow): ResolvedPage {
  if (row.status === "ok") return { status: "ok", text: row.content ?? "" };
  // taken_down is the only remaining non-ok terminal state.
  return { status: "taken_down", text: TAKEN_DOWN_PLACEHOLDER };
}
