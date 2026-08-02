/**
 * The generation prompt — assembled from four independent parameters
 * (docs/reference/generation.md).
 *
 * The prompt used to open by establishing an endless library and framing the
 * model as a *transcriber* of a page found in it. That framing existed to stop
 * the model narrating *being* a page ("I am a page, thin and quiet…"), and it
 * worked — but it cost thirty words, and it primed "library" so hard that a
 * second constraint had to spend eighteen more undoing it on three pages in
 * four. Testing four formats against a live model showed a bare
 * "Generate … text" opener produces no assistant preamble and no self-narration
 * either: stating that the text *begins mid-sentence* does the same job in three
 * words, because a text that starts mid-sentence cannot also introduce itself.
 *
 * So `base-v2` states four things and nothing else:
 *
 *   Generate about 270 words of text. It begins mid-sentence and ends
 *   mid-sentence. Something in it has to do with turquoise.
 *
 *   length  — drawn per page from [pageMinWords, pageMaxWords]
 *   start   — how abruptly it opens        } drawn independently:
 *   end     — how abruptly it stops        } nine combinations
 *   seed    — the gallery's association term (lib/gallerySeeds.ts)
 *
 * Prose, not a `Key: value` block. In testing, a block overshot the stated word
 * count by 17–23% and ignored its own `Ends: mid-sentence.` line — a parameter
 * list reads as metadata *describing* the text rather than instructions for it.
 *
 * On top of that sits the **constraints pool** (`GENERATION_CONSTRAINTS`):
 * facts about the text, each sampled independently per page by its own
 * probability. A constraint is a *dial*, not a rule — no register labels, no
 * combinatorial axes, no per-variant A/B machinery. Applied ids are logged as a
 * `+id` suffix on `prompt_variant`.
 *
 * Worth knowing before reaching for this file to fix variety: all four tested
 * formats produced the same literary-vignette register. Prompt *wording* is not
 * what holds the pages in one place — the seed term and the model choice move
 * the distribution; phrasing barely does.
 */

/** How abruptly the text opens or stops. Logged per page as provenance. */
export type Abruptness = "mid-sentence" | "mid-word" | "clean";

export interface AbruptnessOption {
  id: Abruptness;
  // Slots into both "It begins ___" and "and ends ___", so every value reads
  // correctly in either position.
  phrase: string;
  weight: number;
}

/**
 * `mid-word` is the most aggressive and the most true to a real page — a book's
 * page break lands wherever it lands — but it is also the most likely to read
 * as a broken generation rather than an authentic slice, so it stays rare.
 * Drawn separately for start and end, giving nine combinations.
 */
export const ABRUPTNESS: readonly AbruptnessOption[] = [
  { id: "mid-sentence", phrase: "mid-sentence", weight: 45 },
  { id: "clean", phrase: "cleanly", weight: 40 },
  { id: "mid-word", phrase: "mid-word", weight: 15 },
];

/** Weighted draw from the abruptness pool, off the caller's seeded stream. */
export function pickAbruptness(rng: () => number): AbruptnessOption {
  const total = ABRUPTNESS.reduce((sum, o) => sum + o.weight, 0);
  let r = rng() * total;
  for (const option of ABRUPTNESS) {
    r -= option.weight;
    if (r <= 0) return option;
  }
  return ABRUPTNESS[ABRUPTNESS.length - 1]; // floating-point rounding fallback
}

export interface PromptContext {
  // Drawn per page from the address-seeded stream (lib/generate.ts), not a
  // constant — length is an entropy axis, not a fixed page size.
  maxWords: number;
  // Abruptness phrases, drawn independently. Default to the commonest value so
  // a minimal caller (tests) still builds a valid prompt.
  start?: string;
  end?: string;
  // Sampled constraint sentences (GENERATION_CONSTRAINTS), appended in order.
  // Facts about the text, never orders to a writer. Empty when nothing fired.
  constraints?: readonly string[];
  // One association term drawn from the page's *gallery* (lib/gallerySeeds.ts),
  // stable across every page of a volume. Undefined when the gallery has no
  // stored terms yet or the association call failed — the prompt then simply
  // omits the clause.
  seedTerm?: string;
}

type PromptBuilder = (ctx: PromptContext) => string;

export interface PromptConstraint {
  id: string; // short slug, logged as a prompt_variant suffix
  text: string; // full sentence appended to the prompt
  probability: number; // chance per page of applying, in [0, 1]
}

/**
 * The dynamic-constraint pool: facts about the text, sampled independently, so
 * a constraint is a *dial* rather than a rule.
 *
 * Every entry is an **entropy dial** — a low-probability proscription that
 * closes off one habitual move, so the model has to reach somewhere it would
 * not otherwise go. They are deliberately *negative*. The removed
 * GENERATION_FORMS lever (commit 6d613cc) prescribed a register ("reads like a
 * prayer") and produced pastiche — the model writes *toward* a label.
 * Forbidding names no destination, so it widens the output distribution instead
 * of relocating it. Keep new dials that way.
 *
 * This pool used to also carry two *correctives* at 0.75 — `no-library`, which
 * suppressed the theme the old opener primed, and `self-reference`, which
 * stopped the model titling itself "Page 47,821,903 of the Unbound Codex".
 * Both were deleted with the premise that caused them: there is no library in
 * the prompt to mention, and no "page" language to self-reference.
 *
 * Each dial is independent, so they stack combinatorially — that pressure is
 * the point (two firing together lands on ~14% of pages, three on ~2%). They
 * are also the only remaining lever that constrains *what kind of thing* the
 * text is, which matters more than it looks: every prompt format tested
 * produced the same literary-vignette register without them.
 */
export const GENERATION_CONSTRAINTS: readonly PromptConstraint[] = [
  {
    id: "no-persons",
    text: "No human being appears in it — no one acts and no one is described.",
    probability: 0.15,
  },
  {
    id: "no-speech",
    text: "Nothing in it is said aloud, quoted, or set as dialogue.",
    probability: 0.15,
  },
  {
    id: "no-sequence",
    text: "Nothing in it happens in sequence, one event after another.",
    probability: 0.15,
  },
  {
    id: "no-abstraction",
    text:
      "It names only what could be touched or counted, holding to concrete " +
      "particulars throughout.",
    probability: 0.15,
  },
  {
    id: "no-past",
    text: "Nothing in it is described as having already happened.",
    probability: 0.15,
  },
];

const VARIANTS: Record<string, PromptBuilder> = {
  // One paragraph, one sentence per parameter. `base-v1` (the endless-library
  // transcriber prompt) is retired rather than kept alongside: commit d8905e0
  // deliberately collapsed generation to a single variant, and the id is bumped
  // because reusing it would make provenance lie — rows recording `base-v1`
  // came from materially different text.
  "base-v2": ({
    maxWords,
    start = "mid-sentence",
    end = "mid-sentence",
    constraints = [],
    seedTerm,
  }) =>
    [
      `Generate about ${maxWords} words of text.`,
      `It begins ${start} and ends ${end}.`,
      // The gallery's association term. Deliberately loose ("something in it
      // has to do with"): a bare noun stated as the subject turns the text into
      // an encyclopedia entry about it.
      ...(seedTerm ? [`Something in it has to do with ${seedTerm}.`] : []),
      ...constraints,
    ].join(" "),
};

export const DEFAULT_PROMPT_VARIANT = "base-v2";

export const PROMPT_VARIANT_IDS = Object.keys(VARIANTS);

export function buildPrompt(variantId: string, ctx: PromptContext): string {
  const builder = VARIANTS[variantId];
  if (!builder) {
    throw new Error(`Unknown prompt variant: ${variantId}`);
  }
  return builder(ctx);
}
