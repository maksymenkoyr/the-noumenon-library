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
  // Drawn per page from the address-seeded stream (lib/generate.ts), not a
  // constant — see the length note on the builder below.
  maxWords: number;
  // Sampled constraint sentences (GENERATION_CONSTRAINTS), appended to the
  // prompt in order. Facts about the found page, never orders to a writer —
  // the transcriber framing holds. Empty when nothing fired.
  constraints?: readonly string[];
  // One association term drawn from the page's *gallery* (lib/gallerySeeds.ts),
  // stable across every page of a volume. Undefined when the gallery has no
  // stored terms yet or the association call failed — the prompt then reads
  // exactly as it did before this lever existed.
  seedTerm?: string;
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

/**
 * The length/shape clause used to end "...and it must read as a finished whole
 * — never cut off mid-thought." That clause cancelled the fragment permission
 * standing beside it: measured across every page stored at the time, the
 * collection ran 320–417 words with a 367 mean and *no* fragments at all, so
 * the stated range was fiction. Two causes, both fixed here — `maxWords` was a
 * constant (it is now drawn per page, lib/generate.ts), and "finished whole"
 * forced every page into the shape of a complete little essay.
 *
 * A page of a real book is a slice: it begins and ends wherever the previous
 * and next pages leave off. Saying so makes partialness *diegetic* rather than
 * a truncated-looking generation — the distinction matters, since an empty or
 * clipped completion is a genuine failure mode that lib/generate.ts retries.
 */
const VARIANTS: Record<string, PromptBuilder> = {
  "base-v1": ({ maxWords, constraints = [], seedTerm }) =>
    [
      "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
      "",
      [
        "What is on it may be a few lines or fill the page, up to about " +
          `${maxWords} words. A page is a slice: it may begin or end ` +
          "mid-sentence, and needs no beginning or ending of its own.",
        // The gallery's association term. Deliberately loose ("something ...
        // has to do with"): a bare noun stated as the subject turns the page
        // into an encyclopedia entry about it. Sits before the constraints so
        // the negative facts read as refinements of it.
        ...(seedTerm ? [`Something on this page has to do with ${seedTerm}.`] : []),
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
