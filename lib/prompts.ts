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
  // Sampled constraints (GENERATION_CONSTRAINTS), appended to the prompt in
  // order. Facts about the found page, never orders to a writer — the
  // transcriber framing holds. Empty when nothing fired. Passed whole rather
  // than as bare sentences so each one keeps its id for the dev overlay.
  constraints?: readonly PromptConstraint[];
}

/**
 * One labeled piece of an assembled prompt. Builders emit segments rather than
 * a finished string so the dev overlay (app/[[...address]]/dev-badge) can show
 * *which* part is which — a glued-together blob hides whether a constraint
 * fired at all. `buildPrompt` joins them back into the exact string sent as the
 * user message, so the segmentation is a view onto the prompt, never a change
 * to it.
 */
export interface PromptSegment {
  // "framing", "length", or a GENERATION_CONSTRAINTS id.
  id: string;
  // The text exactly as it appears in the assembled prompt.
  text: string;
  // How this segment attaches to the one before it when joined: its own
  // paragraph, or another sentence in the running one.
  join: "paragraph" | "sentence";
  // Sampling probability, on constraint segments only — the dial's setting,
  // shown alongside the id in the overlay.
  probability?: number;
}

type PromptBuilder = (ctx: PromptContext) => PromptSegment[];

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
];

const VARIANTS: Record<string, PromptBuilder> = {
  "base-v1": ({ maxWords, constraints = [] }) => [
    {
      id: "framing",
      join: "paragraph",
      text:
        "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
    },
    {
      id: "length",
      join: "paragraph",
      text:
        "The text may be a brief fragment or fill the page, but no more than " +
        `about ${maxWords} words, and it must read as a finished whole — ` +
        "never cut off mid-thought.",
    },
    // Constraints ride as further sentences of the length paragraph.
    ...constraints.map((c) => ({
      id: c.id,
      join: "sentence" as const,
      text: c.text,
      probability: c.probability,
    })),
  ],
};

export const DEFAULT_PROMPT_VARIANT = "base-v1";

export const PROMPT_VARIANT_IDS = Object.keys(VARIANTS);

/**
 * The prompt as its labeled parts (dev-overlay provenance). The segments are
 * the primitive; `buildPrompt` below is their concatenation, so the two can
 * never disagree about what was sent.
 */
export function buildPromptSegments(
  variantId: string,
  ctx: PromptContext,
): PromptSegment[] {
  const builder = VARIANTS[variantId];
  if (!builder) {
    throw new Error(`Unknown prompt variant: ${variantId}`);
  }
  return builder(ctx);
}

/**
 * Assemble segments into the exact string sent as the user message: a
 * `paragraph` segment opens a new one (blank line between), a `sentence`
 * segment continues the running paragraph.
 */
export function joinSegments(segments: readonly PromptSegment[]): string {
  return segments
    .map((seg, i) => (i === 0 ? seg.text : (seg.join === "paragraph" ? "\n\n" : " ") + seg.text))
    .join("");
}

export function buildPrompt(variantId: string, ctx: PromptContext): string {
  return joinSegments(buildPromptSegments(variantId, ctx));
}
