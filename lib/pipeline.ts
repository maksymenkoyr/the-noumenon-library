import type { BookContext } from "./book";
import type { GenerationUsage } from "./economics";
import {
  chooseLevers,
  generatePage,
  type GenerationLevers,
  type LeverOverrides,
} from "./generate";
import { moderate } from "./moderate";
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
  // Runs generation for the given levers, folds in usage, and — since
  // generatePage() may fall back to a different pool model on a retryable
  // error — updates `levers.model`/`levers.provider` in place so provenance
  // always names the model that actually produced the content, not just the
  // one requested.
  const run = async (l: GenerationLevers): Promise<string> => {
    const result = await generatePage(l);
    usage.tokens += result.usage.tokens;
    usage.costUsd += result.usage.costUsd;
    l.model = result.model;
    l.provider = result.provider;
    return result.text;
  };

  // Track levers alongside content so provenance always matches what we commit.
  let levers = await chooseLevers(overrides);
  let content = await run(levers);

  if (!(await moderate(content)).ok) {
    // Moderation fail → regenerate once with fresh levers (architecture §7).
    levers = await chooseLevers(overrides);
    content = await run(levers);
    if (!(await moderate(content)).ok) {
      // Two rejects in a row. We never store failing content, but we no longer
      // permanently dark-shelf the address — flag it and bail so resolvePage
      // releases the reservation and a later visit retries (§7). A recurring
      // offender keeps firing this event for a human to investigate / take down.
      await monitor("moderation_persistent_reject", { address, rejects: 2 });
      throw new Error(`Moderation rejected ${address} twice`);
    }
  }

  // Dedup: on an exact-hash collision with another address, regenerate once
  // (a fresh sample) (§8). The regen must itself pass moderation before it can
  // replace the already-passed content; otherwise keep the original (near-
  // duplicates are allowed by design — no dark-shelving for a mere collision).
  if (await contentExistsElsewhere(hashContent(content), address)) {
    const dedupLevers = await chooseLevers(overrides);
    const dedupContent = await run(dedupLevers);
    if ((await moderate(dedupContent)).ok) {
      levers = dedupLevers;
      content = dedupContent;
    }
  }

  return { content, provenance: provenanceFrom(levers), usage };
}
