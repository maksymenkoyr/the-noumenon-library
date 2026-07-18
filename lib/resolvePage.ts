import { normalizeAddress } from "./address";
import { maybeTitleBook, resolveBookContext, type BookContext } from "./book";
import { condensePage } from "./condense";
import { config } from "./config";
import {
  checkAdmission,
  noteGeneration,
  recordSpend,
  type AdmissionContext,
  type GenerationUsage,
} from "./economics";
import { devLog } from "./log";
import { monitor } from "./monitor";
import { generatePipeline } from "./pipeline";
import {
  commitPage,
  getPage,
  reclaimStaleReservation,
  releaseReservation,
  reservePage,
  setCondensed,
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
  // Dev-overlay provenance (lib/devMode, app/[[...address]]/dev-badge), ignored
  // by non-dev callers. `model` is present whenever known — a fresh generation
  // and a committed revisit alike; `durationMs` is measured live during a fresh
  // generation only, so revisits (never re-timed) leave it undefined.
  model?: string;
  durationMs?: number;
}

const TAKEN_DOWN_PLACEHOLDER =
  "This leaf has been removed from the library.";

const EXPLORE_ONLY_PLACEHOLDER =
  "This corner of the library is still dark — wander elsewhere and return later.";

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
    const startedAt = Date.now();
    // Books experiment (docs/reference/books.md): resolve the book row + condensed
    // neighbors before generating. Aux LLM cost (lazy neighbor condensation,
    // and the post-commit calls below) accumulates here so recordSpend sees it.
    const auxUsage: GenerationUsage = { tokens: 0, costUsd: 0 };
    let bookCtx: BookContext | undefined;
    if (config.bookMode) {
      const addr = normalizeAddress(address.split("/"));
      if (addr) bookCtx = await resolveBookContext(addr, auxUsage);
    }
    const { content, provenance, usage } = await generatePipeline(address, bookCtx);
    const durationMs = Date.now() - startedAt;
    if (!(await commitPage(address, content, provenance))) {
      // The reservation is gone or no longer 'generating' — a takedown landed
      // mid-generation (which must win, docs/reference/legal.md), or the row was
      // released/reclaimed by another request. The LLM spend still happened,
      // so record it, then serve whatever the store holds now rather than
      // presenting the orphaned content as committed.
      await recordSpend({
        tokens: usage.tokens + auxUsage.tokens,
        costUsd: usage.costUsd + auxUsage.costUsd,
      });
      await monitor("commit_lost", { address });
      const row = await getPage(address);
      if (row && row.status !== "generating") return resolved(row);
      return { status: "explore", text: EXPLORE_ONLY_PLACEHOLDER };
    }
    if (bookCtx) {
      // Post-commit, awaited but non-fatal — the page is already live, and
      // detaching would drop the work when a serverless function freezes.
      // Failures degrade: condensed stays NULL (the lazy neighbor-read path
      // backstops it) and the title retries on the volume's next page.
      try {
        const { condensed, usage: condenseUsage } = await condensePage(content);
        auxUsage.tokens += condenseUsage.tokens;
        auxUsage.costUsd += condenseUsage.costUsd;
        await setCondensed(address, condensed);
      } catch (error) {
        devLog(
          `condensed write failed for ${address} (lazy path will retry):`,
          error instanceof Error ? error.message : error,
        );
      }
      await maybeTitleBook(bookCtx.book, content, auxUsage); // never throws
    }
    await recordSpend({
      tokens: usage.tokens + auxUsage.tokens,
      costUsd: usage.costUsd + auxUsage.costUsd,
    });
    return { status: "ok", text: content, model: provenance.model, durationMs };
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
  // Revisit: the model is on the stored row; duration was never persisted
  // (live-only), so the overlay shows model without a time.
  if (row.status === "ok")
    return { status: "ok", text: row.content ?? "", model: row.model ?? undefined };
  // taken_down is the only remaining non-ok terminal state.
  return { status: "taken_down", text: TAKEN_DOWN_PLACEHOLDER };
}
