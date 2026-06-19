import { chooseLevers, generatePage, type GenerationLevers } from "./generate";
import { moderate } from "./moderate";
import { monitor } from "./monitor";
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
}

function provenanceFrom(levers: GenerationLevers): PageProvenance {
  return {
    model: levers.model,
    temperature: levers.temperature,
    prompt_variant: levers.promptVariant,
  };
}

export async function generatePipeline(address: string): Promise<PipelineResult> {
  // Track levers alongside content so provenance always matches what we commit.
  let levers = chooseLevers();
  let content = await generatePage(levers);

  if (!(await moderate(content)).ok) {
    // Moderation fail → regenerate once with fresh levers (architecture §7).
    levers = chooseLevers();
    content = await generatePage(levers);
    if (!(await moderate(content)).ok) {
      // Two rejects in a row. We never store failing content, but we no longer
      // permanently dark-shelf the address — flag it and bail so resolvePage
      // releases the reservation and a later visit retries (§7). A recurring
      // offender keeps firing this event for a human to investigate / take down.
      monitor("moderation_persistent_reject", { address, rejects: 2 });
      throw new Error(`Moderation rejected ${address} twice`);
    }
  }

  // Dedup: on an exact-hash collision with another address, regenerate once
  // (a fresh sample) (§8). The regen must itself pass moderation before it can
  // replace the already-passed content; otherwise keep the original (near-
  // duplicates are allowed by design — no dark-shelving for a mere collision).
  if (await contentExistsElsewhere(hashContent(content), address)) {
    const dedupLevers = chooseLevers();
    const dedupContent = await generatePage(dedupLevers);
    if ((await moderate(dedupContent)).ok) {
      levers = dedupLevers;
      content = dedupContent;
    }
  }

  return { content, provenance: provenanceFrom(levers) };
}
