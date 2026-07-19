import type { BookContext } from "./book";
import type { GenerationUsage } from "./economics";
import {
  chooseLevers,
  generatePage,
  type GenerationLevers,
  type LeverOverrides,
} from "./generate";
import { moderate, type ModerationResult } from "./moderate";
import { monitor } from "./monitor";
import { BOOK_PROMPT_VARIANT } from "./prompts";
import { contentExistsElsewhere, hashContent, type PageProvenance } from "./store";

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
  provenance: PageProvenance;
  // Every LLM generation call in this pipeline, summed — the spend the page
  // actually cost, including regeneration/dedup retries (§10). Moderation tokens
  // are not counted (free models; the dominant cost is generation).
  usage: GenerationUsage;
  // The exact prompt that produced `content` — dev-overlay provenance
  // (lib/devMode), not persisted. Tracks whichever attempt (initial /
  // moderation regen / dedup regen) ended up committed, same as `levers`.
  prompt: string;
  // Wall time spent in generation vs moderation, reported separately rather
  // than folded into one total — each summed across every attempt in this
  // run (including moderation/dedup regenerations), since a retry really did
  // spend that time.
  generationMs: number;
  moderationMs: number;
  // The chain link that passed whichever attempt ended up committed — dev-
  // overlay provenance, same tracking rule as `prompt`/`levers` above.
  // Undefined only if moderation was disabled outright (lib/moderate.ts).
  moderationModel?: string;
}

function provenanceFrom(levers: GenerationLevers): PageProvenance {
  return {
    model: levers.model,
    temperature: levers.temperature,
    prompt_variant: levers.promptVariant,
    seed_word: levers.form,
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
  // provenance always matches what we commit.
  let levers = await chooseLevers(overrides);
  let { text: content, prompt } = await run(levers);

  let modResult = await check(content);
  if (!modResult.ok) {
    // Moderation fail → regenerate once with fresh levers (architecture §7).
    levers = await chooseLevers(overrides);
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
    const dedupLevers = await chooseLevers(overrides);
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
    provenance: provenanceFrom(levers),
    usage,
    prompt,
    generationMs,
    moderationMs,
    moderationModel,
  };
}
