/**
 * Prompt variants — the prompt-variation entropy lever (docs/generation.md).
 *
 * The generation prompt is the highest-leverage artifact in the project. The
 * model is framed as a *transcriber* of a text found in the library, never as
 * the page itself — the earlier "you are a page … generate the text found on
 * this page" framing made the model narrate *being* a page ("I am a page, thin
 * and quiet…"), the self-orientation the "you do not know what you are" phrase
 * was meant to prevent. Here the not-knowing is re-aimed at the page ("what it
 * is"), and each page is given a random **form/register** (`GENERATION_FORMS`)
 * so pages diverge instead of converging on one voice — the main prompt-side
 * variety lever while model rotation is pinned to a single model.
 *
 * The text is still framed as *found*, not written to order (frees the model
 * from intentionality); anti-patterns in docs/generation.md are respected. The
 * chosen variant id and form are logged per page as provenance (the form in the
 * reserved `seed_word` column).
 */

export interface PromptContext {
  maxWords: number;
  form: string;
}

type PromptBuilder = (ctx: PromptContext) => string;

/**
 * The kinds of text a page might turn out to be — chosen at random per page to
 * spread output across registers (factual / interior / formal / vernacular).
 * Each entry carries its own article so it slots after "reads like ".
 */
export const GENERATION_FORMS: readonly string[] = [
  "a field guide entry",
  "an unsent letter",
  "a prayer",
  "a recipe",
  "a ship's log",
  "a legal statute",
  "a lullaby",
  "a transcript of an argument",
  "an obituary",
  "marginalia scrawled in an older book",
  "a weather report",
  "a museum placard",
  "a diary entry",
  "a fragment of a myth",
  "a set of assembly instructions",
  "a confession",
  "a menu",
  "a scientific abstract",
  "a folk remedy",
  "an incantation",
  "a telegram",
  "a classified advertisement",
  "a eulogy",
  "a dream written down on waking",
  "an inventory",
  "a riddle",
  "a travelogue",
  "a court testimony",
  "a horoscope",
  "an epitaph",
  "a saint's life",
  "a customer complaint",
];

const VARIANTS: Record<string, PromptBuilder> = {
  "base-v2": ({ maxWords, form }) =>
    [
      "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
      "",
      `The writing on this page reads like ${form}. It may be a brief fragment ` +
        `or fill the leaf, but no more than about ${maxWords} words, and it ` +
        "must read as a finished whole — never cut off mid-thought.",
    ].join("\n"),
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
