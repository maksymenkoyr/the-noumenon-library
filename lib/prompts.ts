/**
 * Prompt variants — the prompt-variation entropy lever (docs/reference/generation.md).
 *
 * The generation prompt is the highest-leverage artifact in the project. The
 * model is framed as a *transcriber* of a text found in the library, never as
 * the page itself — an earlier "you are a page … generate the text found on
 * this page" framing made the model narrate *being* a page ("I am a page, thin
 * and quiet…"), the self-orientation the "you do not know what you are" phrase
 * is meant to prevent. Here the not-knowing is aimed at the page ("what it
 * is"), not the model.
 *
 * There is a single base variant, `base-v1`. All prompt-side variety comes
 * from the **constraints pool** (`GENERATION_CONSTRAINTS`): a set of facts
 * about the found page, each sampled independently per page by its own
 * probability, appended as plain sentences. A constraint is a *dial*, not a
 * rule — no register labels, no combinatorial axes, no per-variant A/B
 * machinery. The text is still framed as *found*, not written to order (frees
 * the model from intentionality); anti-patterns in
 * docs/reference/generation.md are respected. The chosen constraint ids are
 * logged per page as provenance (a `+id` suffix on `prompt_variant`).
 */

export interface PromptContext {
  maxWords: number;
  // Sampled constraint sentences (GENERATION_CONSTRAINTS), appended to the
  // prompt in order. Facts about the found page, never orders to a writer —
  // the transcriber framing holds. Empty when nothing fired.
  constraints?: readonly string[];
}

type PromptBuilder = (ctx: PromptContext) => string;

/**
 * The dynamic-constraint pool: the sole prompt-side variety lever. Each entry
 * is sampled independently per page with its own probability, so a constraint
 * is a *dial*, not a rule.
 *
 * `no-library` exists because the opener's "endless library" primes the
 * models hard: two 20-page wander reports each had ~6 pages set in or about
 * infinite libraries — the prompt's fingerprint, not the collection's honest
 * base rate. A global ban would be wrong (a library of every text does
 * contain pages about libraries); applying the exclusion to about three
 * quarters of pages restores rarity while keeping the topic possible.
 *
 * `self-reference` guards against the "Page 47,821,903 of the Unbound Codex"
 * self-titling tic — the model narrating that it *is* a page, giving itself a
 * page number, or addressing the reader. Sampled like any other dial rather
 * than hardcoded into the builder, so the pool stays the single source of
 * every appended sentence.
 *
 * Everything below `self-reference` is an **entropy dial**: a low-probability
 * proscription that closes off one habitual move, so the model has to reach
 * somewhere it would not otherwise go. They are deliberately *negative*. The
 * removed GENERATION_FORMS lever (commit 6d613cc) prescribed a register
 * ("reads like a prayer") and produced pastiche — the model writes *toward* a
 * label. Forbidding names no destination, so it widens the output distribution
 * instead of relocating it. Both surviving pre-existing constraints are
 * negative for the same reason; keep new dials that way.
 *
 * Each is independent, so they stack combinatorially — that pressure is the
 * point (two firing together lands on ~14% of pages, three on ~2%), but it is
 * also why they sit at 0.15 rather than the 0.75 of the two corrective
 * constraints above. Those two fix a known failure; these only widen the range.
 *
 * The chosen ids are logged in provenance (`prompt_variant` suffix, e.g.
 * `base-v1+no-library`) so wander reports can attribute each constraint's
 * effect.
 */
export interface PromptConstraint {
  id: string; // short slug, logged as a prompt_variant suffix
  text: string; // full sentence appended to the prompt
  probability: number; // chance per page of applying, in [0, 1]
}

export const GENERATION_CONSTRAINTS: readonly PromptConstraint[] = [
  {
    id: "no-library",
    text:
      "This particular page happens to contain no mention of libraries, " +
      "shelves, archives, librarians, or infinite collections of texts.",
    probability: 0.75,
  },
  {
    id: "self-reference",
    text:
      "This particular page does not speak of itself as a page, give itself " +
      "a page number, or address whoever is reading it.",
    probability: 0.75,
  },
  {
    id: "no-persons",
    text:
      "This particular page has no human being anywhere in it — no one acts " +
      "on it and no one is described.",
    probability: 0.15,
  },
  {
    id: "no-speech",
    text:
      "This particular page carries no speech: nothing on it is said aloud, " +
      "quoted, or set as dialogue.",
    probability: 0.15,
  },
  {
    id: "no-sequence",
    text:
      "This particular page does not narrate — nothing on it happens in " +
      "sequence, one event after another.",
    probability: 0.15,
  },
  {
    id: "no-abstraction",
    text:
      "This particular page names only what could be touched or counted, " +
      "holding throughout to concrete particulars.",
    probability: 0.15,
  },
  {
    id: "no-past",
    text: "This particular page describes nothing as having already happened.",
    probability: 0.15,
  },
];

const VARIANTS: Record<string, PromptBuilder> = {
  "base-v1": ({ maxWords, constraints = [] }) =>
    [
      "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
      "",
      [
        "The text may be a brief fragment or fill the page, but no more than " +
          `about ${maxWords} words, and it must read as a finished whole — ` +
          "never cut off mid-thought.",
        ...constraints,
      ].join(" "),
    ].join("\n"),
};

export const DEFAULT_PROMPT_VARIANT = "base-v1";

export const PROMPT_VARIANT_IDS = Object.keys(VARIANTS);

export function buildPrompt(variantId: string, ctx: PromptContext): string {
  const builder = VARIANTS[variantId];
  if (!builder) {
    throw new Error(`Unknown prompt variant: ${variantId}`);
  }
  return builder(ctx);
}
