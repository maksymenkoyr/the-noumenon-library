/**
 * Prompt variants — the prompt-variation entropy lever (docs/reference/generation.md).
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
 * from intentionality); anti-patterns in docs/reference/generation.md are respected. The
 * chosen variant id and form are logged per page as provenance (the form in the
 * reserved `seed_word` column).
 */

export interface PromptContext {
  maxWords: number;
  form: string;
  // Books experiment (docs/reference/books.md): condensed neighbor pages in the same
  // volume, present only when already committed. Their first/last sentences
  // are near-verbatim (lib/condense.ts), so the seam constraint the model
  // must satisfy is concrete text, not a vibe. Never coordinates — the
  // address stays out of the prompt (docs/reference/generation.md).
  prev?: string;
  next?: string;
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

/**
 * Books experiment (docs/reference/books.md): the volume is a book with a locked form,
 * and a page connects to its committed neighbors via their condensed text.
 * Four cases, one variant slug (the case is recoverable from which neighbors
 * existed at generation time). The self-narration lessons hold throughout:
 * the model stays a *reader*, the not-knowing is aimed at the book, no
 * coordinate ever appears, and every neighbor block carries an explicit
 * no-repeat/no-remark clause so the seam is continued, not narrated.
 */
const BOOK_INTRO =
  "An endless library holds every text that could ever be written, bound " +
  "into volumes.";

function bookV1({ maxWords, form, prev, next }: PromptContext): string {
  if (prev && next) {
    return [
      `${BOOK_INTRO} You are reading a book from it, and one leaf sits ` +
        "between two others. This was on the page BEFORE it — its middle " +
        "abridged, its opening and closing words exact:",
      "",
      "<<<",
      prev,
      ">>>",
      "",
      "And this is on the page AFTER it:",
      "",
      "<<<",
      next,
      ">>>",
      "",
      "Set down exactly what is on the page between them. It is the same " +
        "text going on: it takes up where the first passage leaves off, and " +
        "its final words lead naturally into the second passage's opening — " +
        "without repeating, quoting, or remarking on either. The writing in " +
        `this book reads like ${form}. No more than about ${maxWords} words.`,
    ].join("\n");
  }
  if (prev) {
    return [
      `${BOOK_INTRO} You are reading a book from it and have just turned a ` +
        "page. This was on the page you turned — its middle abridged, its " +
        "opening and closing words exact:",
      "",
      "<<<",
      prev,
      ">>>",
      "",
      "Set down exactly what is on the page now in front of you. It is the " +
        "same text going on: it takes up where the words above leave off, " +
        "without repeating them, without summarizing them, and without " +
        `remarking on them. The writing in this book reads like ${form}. ` +
        `No more than about ${maxWords} words, and the page must end at a ` +
        "natural resting point — never cut off mid-thought.",
    ].join("\n");
  }
  if (next) {
    return [
      `${BOOK_INTRO} You are reading a book from it. This is on the page ` +
        "that FOLLOWS the one in front of you — its middle abridged, its " +
        "opening and closing words exact:",
      "",
      "<<<",
      next,
      ">>>",
      "",
      "Set down exactly what is on the page in front of you, the page " +
        "BEFORE the one above. It is the same text: its final words must " +
        "lead naturally into the opening words above, without quoting them, " +
        "repeating them, or remarking on them. The writing in this book " +
        `reads like ${form}. No more than about ${maxWords} words.`,
    ].join("\n");
  }
  return [
    `${BOOK_INTRO} You are reading a page from one of its books; set down ` +
      "exactly what is on it. You do not know what the book is or where " +
      "it sits.",
    "",
    `The writing in this book reads like ${form}. The page may be a brief ` +
      `fragment or fill the leaf, but no more than about ${maxWords} words, ` +
      "and it must read as a finished whole — never cut off mid-thought.",
  ].join("\n");
}

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
  "book-v1": bookV1,
};

/** The variant every book-mode page is generated (and logged) under. */
export const BOOK_PROMPT_VARIANT = "book-v1";

/**
 * Middle-of-page condensation (lib/condense.ts) — the reverse bell curve's
 * flattened center. Only ever sees the middle; the seams are kept verbatim
 * by the caller.
 */
export function buildCondenseMiddlePrompt(
  middle: string,
  maxWords: number,
): string {
  return [
    `Condense the following passage to at most ${maxWords} words. Keep ` +
      "names, places, and concrete events; drop everything ornamental. " +
      "Reply with the condensed passage only — no preamble, no commentary.",
    "",
    "<<<",
    middle,
    ">>>",
  ].join("\n");
}

/**
 * Title/tags for a newly-seeded book, invented from its first committed page.
 * A separate post-commit call (free models are unreliable at multi-part
 * structured replies, and a parse failure must never taint the page itself).
 * Plain-text protocol per the moderate.ts house pattern.
 */
export function buildBookMetadataPrompt(firstPageContent: string): string {
  return [
    "Here is the text of a page from a book in an endless library. Invent " +
      "the title of the book it belongs to, and three to five subject tags " +
      "a cataloguer might file it under.",
    "",
    "Answer in exactly this format, with nothing before or after:",
    "TITLE: <title, at most twelve words>",
    "TAGS: <tag>, <tag>, <tag>",
    "",
    "<<<",
    firstPageContent,
    ">>>",
  ].join("\n");
}

/** Strip markdown/quote dressing free models like to add around a value. */
function stripDressing(value: string): string {
  return value.replace(/^[\s*_`"'“”‘’]+|[\s*_`"'“”‘’]+$/g, "");
}

/**
 * Tolerant, moderate.ts-style parse of the title/tags reply: scan every line
 * (reasoning preamble tolerated), take the last TITLE:/TAGS: lines, strip
 * dressing. No usable TITLE → null; the caller leaves the book untitled and
 * the next page in the volume retries.
 */
export function parseBookMetadata(
  reply: string | null | undefined,
): { title: string; tags: string[] } | null {
  if (!reply) return null;
  let title: string | null = null;
  let tags: string[] = [];
  for (const line of reply.split("\n")) {
    const titleMatch = line.match(/^\s*\**TITLE\**\s*:\s*(.+)$/i);
    if (titleMatch) title = stripDressing(titleMatch[1]);
    const tagsMatch = line.match(/^\s*\**TAGS\**\s*:\s*(.+)$/i);
    if (tagsMatch) {
      tags = tagsMatch[1]
        .split(/[,;]/)
        .map((tag) => stripDressing(tag))
        .filter(Boolean)
        .slice(0, 5);
    }
  }
  if (!title) return null;
  return { title, tags };
}

export const DEFAULT_PROMPT_VARIANT = "base-v2";

export const PROMPT_VARIANT_IDS = Object.keys(VARIANTS);

export function buildPrompt(variantId: string, ctx: PromptContext): string {
  const builder = VARIANTS[variantId];
  if (!builder) {
    throw new Error(`Unknown prompt variant: ${variantId}`);
  }
  return builder(ctx);
}
