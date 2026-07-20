import type { BookContext } from "./book";
import type { GenerationUsage } from "./economics";
import {
  axisFingerprint,
  chooseLevers,
  generatePage,
  provenanceVariant,
  type GenerationLevers,
  type LeverOverrides,
} from "./generate";
import { moderate, type ModerationResult } from "./moderate";
import { monitor } from "./monitor";
import { BOOK_PROMPT_VARIANT } from "./prompts";
import { contentExistsElsewhere, hashContent, type PageInputs } from "./store";

/**
 * The generation pipeline — architecture §2 steps 5–8 for one novel page:
 * generate → moderate → dedup → return the page content. Concurrency, the store
 * lifecycle, and the commit itself stay in resolvePage.ts.
 *
 * Invariant: any content returned has passed moderation. Content that fails
 * moderation twice is never stored — the pipeline flags it (monitor) and throws,
 * so resolvePage releases the reservation and the address is retried on a later
 * visit. There is no permanent dark-shelf: a genuinely recurring offender keeps
 * firing the monitor event for a human to act on (e.g. takedown).
 */
export interface PipelineResult {
  content: string;
  // Everything that produced `content` — prompt, levers, moderation model,
  // timings — as one record (lib/store.ts PageInputs), persisted whole by
  // commitPage and surfaced by the dev overlay on both fresh generation and
  // revisit. Tracks whichever attempt (initial / moderation regen / dedup
  // regen) ended up committed.
  inputs: PageInputs;
  // Every LLM generation call in this pipeline, summed — the spend the page
  // actually cost, including regeneration/dedup retries (§10). Moderation tokens
  // are not counted (free models; the dominant cost is generation).
  usage: GenerationUsage;
}

function inputsFrom(
  levers: GenerationLevers,
  prompt: string,
  generationMs: number,
  moderationMs: number,
  moderationModel?: string,
): PageInputs {
  return {
    model: levers.model,
    provider: levers.provider,
    temperature: levers.temperature,
    // Applied constraints ride as `+id` suffixes (e.g. `base-v5+no-library`).
    promptVariant: provenanceVariant(levers),
    constraints: levers.constraints.map((c) => c.id),
    // form carries the book's locked form in book mode, else the sampled
    // axis fingerprint (base-v5) — the research signal for which register
    // combinations produce pages worth pausing on.
    form: levers.form ?? axisFingerprint(levers.axes),
    prompt,
    moderationModel,
    generationMs,
    moderationMs,
  };
}

export async function generatePipeline(
  address: string,
  bookCtx?: BookContext,
): Promise<PipelineResult> {
  // Book mode (docs/reference/books.md) pins the book's locked form, the book variant,
  // and the neighbor seams on EVERY attempt — including the moderation and
  // dedup regenerations below — so a retry can't fall out of the book's voice.
  const overrides: LeverOverrides = bookCtx
    ? {
        form: bookCtx.book.form,
        promptVariant: BOOK_PROMPT_VARIANT,
        prev: bookCtx.prev,
        next: bookCtx.next,
      }
    : {};

  // Accumulate the cost of every generation call, including retries below.
  const usage: GenerationUsage = { tokens: 0, costUsd: 0 };
  let generationMs = 0;
  let moderationMs = 0;
  // Runs generation for the given levers, folds in usage and generation
  // time, and — since generatePage() may fall back to a different pool
  // model on a retryable error — updates `levers.model`/`levers.provider` in
  // place so provenance always names the model that actually produced the
  // content, not just the one requested. Also returns the exact prompt sent,
  // for the caller to track alongside content (dev-overlay provenance).
  const run = async (l: GenerationLevers): Promise<{ text: string; prompt: string }> => {
    const result = await generatePage(l);
    usage.tokens += result.usage.tokens;
    usage.costUsd += result.usage.costUsd;
    generationMs += result.durationMs;
    l.model = result.model;
    l.provider = result.provider;
    return { text: result.text, prompt: result.prompt };
  };
  // Runs moderation and folds in its wall time, kept separate from generation
  // time above (dev-overlay provenance — see PipelineResult). Returns the full
  // result (not just ok) so callers can attribute `moderationModel` only to
  // whichever attempt ends up committed, same rule as content/prompt/levers.
  const check = async (text: string): Promise<ModerationResult> => {
    const result = await moderate(text);
    moderationMs += result.ms;
    return result;
  };

  // Track levers and the prompt that produced them alongside content, so
  // provenance always matches what we commit. Levers are address-seeded
  // (lib/generate.ts), and each regeneration below bumps the attempt index so
  // a retry deterministically draws a different sample than the one it replaces.
  let levers = await chooseLevers(address, overrides, 0);
  let { text: content, prompt } = await run(levers);

  let modResult = await check(content);
  if (!modResult.ok) {
    // Moderation fail → regenerate once with fresh levers (architecture §7).
    levers = await chooseLevers(address, overrides, 1);
    ({ text: content, prompt } = await run(levers));
    modResult = await check(content);
    if (!modResult.ok) {
      // Two rejects in a row. We never store failing content, but we no longer
      // permanently dark-shelf the address — flag it and bail so resolvePage
      // releases the reservation and a later visit retries (§7). A recurring
      // offender keeps firing this event for a human to investigate / take down.
      await monitor("moderation_persistent_reject", { address, rejects: 2 });
      throw new Error(`Moderation rejected ${address} twice`);
    }
  }
  let moderationModel = modResult.model;

  // Dedup: on an exact-hash collision with another address, regenerate once
  // (a fresh sample) (§8). The regen must itself pass moderation before it can
  // replace the already-passed content; otherwise keep the original (near-
  // duplicates are allowed by design — no dark-shelving for a mere collision).
  if (await contentExistsElsewhere(hashContent(content), address)) {
    const dedupLevers = await chooseLevers(address, overrides, 2);
    const dedupRun = await run(dedupLevers);
    const dedupModResult = await check(dedupRun.text);
    if (dedupModResult.ok) {
      levers = dedupLevers;
      content = dedupRun.text;
      prompt = dedupRun.prompt;
      moderationModel = dedupModResult.model;
    }
  }

  return {
    content,
    inputs: inputsFrom(levers, prompt, generationMs, moderationMs, moderationModel),
    usage,
  };
}
