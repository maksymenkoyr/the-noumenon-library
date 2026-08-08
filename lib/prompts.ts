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
 * So `base-v3` states three things and nothing else:
 *
 *   Generate about 300 words of text. It begins mid-sentence. The opening is
 *   not marked with an ellipsis. Something in it has to do with turquoise.
 *
 *   length  — an *overshoot* target: more than the page holds, so there is
 *             always material to cut (lib/pageCut.ts)
 *   start   — which seam the page break lands on at the top
 *   seed    — the gallery's association term (lib/gallerySeeds.ts)
 *
 * **The prompt no longer says anything about how the text ends.** `base-v2`
 * did, and it did not work: asked for 400 words it returned 531, 503, 724 and
 * 777 across four live runs, and the "At 400 words it runs out of room"
 * phrasing seems to have *caused* the overrun by implying more text exists.
 * Models cannot count. So the ending moved out of the prompt entirely and
 * became a cut applied to whatever came back — see lib/pageCut.ts. The split
 * is: **prompt what the model can do, compute what it can't.**
 *
 * The start survived that cull because it demonstrably works — asked to begin
 * mid-word the model returns *"mentary evidence suggests…"*. A text that
 * starts mid-sentence also cannot introduce itself, which is what makes the
 * assistant preamble impossible without any framing to forbid it.
 *
 * "The opening is not marked with an ellipsis" is load-bearing: left alone the
 * model signposts the seam with a leading `…`, a narrator's gesture meaning
 * *this is an excerpt*. Real paper does not apologize for where it begins.
 * (lib/pageCut.ts strips them from both edges regardless — the clause is
 * cheaper than a cut that has to clean up after it.)
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

/**
 * Which seam the page break lands on at the **top** of the page — the four
 * places a real book page can start. Logged per page as provenance.
 *
 * There is no matching pool for the bottom of the page. The ending is not
 * something the model can be asked for (lib/pageCut.ts explains why) so it is
 * computed from the returned text instead; only the start survives as a prompt
 * lever, because the model demonstrably obeys it.
 */
export type StartSeam =
  | "mid-word"
  | "mid-sentence"
  | "mid-paragraph"
  | "paragraph-break";

export interface StartSeamOption {
  id: StartSeam;
  // Slots into "It begins ___".
  phrase: string;
  weight: number;
}

/**
 * The four seams, weighted roughly by how often a page break lands on each.
 *
 * `mid-paragraph` is the interesting one: the sentence completes but the
 * paragraph does not, which is the commonest way a real page actually reads —
 * no jagged edge, yet plainly unfinished. Without it the pool was a binary
 * between a clean literary opening and a severed one.
 *
 * `paragraph-break` is deliberately uncommon. It is the one seam that lets the
 * model write a proper opening line, and it does: *"The old lighthouse keeper
 * had not spoken in three days."* is a fine first sentence and a terrible
 * page — a page of a book almost never gets to introduce itself.
 *
 * `mid-word` stays rarest. It is the most true to real paper and the most
 * likely to read as a broken generation rather than an authentic slice.
 */
export const START_SEAMS: readonly StartSeamOption[] = [
  { id: "mid-sentence", phrase: "mid-sentence", weight: 40 },
  { id: "mid-paragraph", phrase: "between two sentences, mid-paragraph", weight: 25 },
  { id: "paragraph-break", phrase: "at the start of a paragraph", weight: 20 },
  { id: "mid-word", phrase: "mid-word", weight: 15 },
];

/** Weighted draw from the start-seam pool, off the caller's seeded stream. */
export function pickStartSeam(rng: () => number): StartSeamOption {
  const total = START_SEAMS.reduce((sum, o) => sum + o.weight, 0);
  let r = rng() * total;
  for (const option of START_SEAMS) {
    r -= option.weight;
    if (r <= 0) return option;
  }
  return START_SEAMS[START_SEAMS.length - 1]; // floating-point rounding fallback
}

/**
 * How much more than a page to ask for, so lib/pageCut.ts always has material
 * to cut. Only a floor matters — the model overshoots any stated count by
 * 26–94% on its own, so this mostly guards the case where it undershoots.
 * Everything past the page is paid for and discarded, which is the price of an
 * ending that is real rather than requested; at the current page size it still
 * costs less per page than the 320–417-word pages it replaces.
 */
export const OVERSHOOT = 1.5;

export interface PromptContext {
  // config.pageWords — the size of the paper, identical on every page in the
  // library. NOT what goes in the prompt: the builder asks for OVERSHOOT times
  // this, because the page is what the text is cut to, not what it aims at.
  pageWords: number;
  // The start-seam phrase. Defaults to the commonest value so a minimal caller
  // (tests) still builds a valid prompt. There is no `end` — see the header.
  start?: string;
  // Set for the `complete` ending only (lib/pageCut.ts): the text is asked to
  // reach its own end at roughly this length instead of overshooting the page.
  completeWords?: number;
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
  // One paragraph, one sentence per parameter. Earlier ids are retired rather
  // than kept alongside: commit d8905e0 deliberately collapsed generation to a
  // single variant, and the id is bumped on every material rewrite because
  // reusing it would make provenance lie — rows recording `base-v2` were
  // written to a prompt that still asked for an ending.
  "base-v3": ({
    pageWords,
    start = "mid-sentence",
    completeWords,
    constraints = [],
    seedTerm,
  }) =>
    [
      // `complete` asks for a finished text at its own length; every other
      // ending asks for more than the page holds and is cut down to it
      // (lib/pageCut.ts). Either way the number is a target the model will
      // miss — which is exactly why it is no longer load-bearing.
      completeWords
        ? `Generate about ${completeWords} words of text, complete in itself.`
        : `Generate about ${Math.round(pageWords * OVERSHOOT)} words of text.`,
      `It begins ${start}.`,
      // Unprompted, the model marks the seam with a leading `…` — a narrator
      // saying "excerpt". The seam is the paper's, not the text's.
      "The opening is not marked with an ellipsis.",
      // The gallery's association term. Deliberately loose ("something in it
      // has to do with"): a bare noun stated as the subject turns the text into
      // an encyclopedia entry about it.
      ...(seedTerm ? [`Something in it has to do with ${seedTerm}.`] : []),
      ...constraints,
    ].join(" "),
};

export const DEFAULT_PROMPT_VARIANT = "base-v3";

export const PROMPT_VARIANT_IDS = Object.keys(VARIANTS);

export function buildPrompt(variantId: string, ctx: PromptContext): string {
  const builder = VARIANTS[variantId];
  if (!builder) {
    throw new Error(`Unknown prompt variant: ${variantId}`);
  }
  return builder(ctx);
}
