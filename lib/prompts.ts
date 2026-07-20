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
  // The register label — book mode only (bookV1). base-v4 dropped it from the
  // base path, so it is absent for ordinary pages.
  form?: string;
  // Dynamic constraints (base-v3/base-v4): sentences appended to the prompt,
  // each sampled per page by its pool probability (GENERATION_CONSTRAINTS).
  // Facts about the found page, never orders to a writer — the transcriber
  // framing holds. Absent/empty for variants that predate the slot.
  constraints?: readonly string[];
  // Assembled "page facts" (base-v5): the rendered axis sentences plus any
  // constraint texts, in order, appended to the prompt as a single paragraph.
  // Supersedes `constraints` for base-v5 — the caller folds constraints into
  // this list (lib/generate.ts).
  facts?: readonly string[];
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
 * The kinds of text a page might turn out to be, each carrying its own article
 * so it slots after "reads like ".
 *
 * As of base-v4 the base path no longer uses a form label at all (the random
 * register steer was dropped — docs/reference/generation.md); this pool now
 * serves book mode only, where a volume locks one register for all its pages
 * (book-v1 / bookV1 below). Kept exported for that and for the retired base-v2
 * / base-v3 variants.
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
 * The dynamic-constraint pool (base-v3). Each entry is sampled independently
 * per page with its own probability, so a constraint is a *dial*, not a rule.
 *
 * The first entry exists because the opener's "endless library" primes the
 * models hard: two 20-page wander reports each had ~6 pages set in or about
 * infinite libraries — the prompt's fingerprint, not the collection's honest
 * base rate. A global ban would be wrong (a library of every text does
 * contain pages about libraries); applying the exclusion to about half of
 * pages restores rarity while keeping the topic possible. The chosen ids are
 * logged in provenance (prompt_variant suffix, e.g. `base-v3+no-library`) so
 * wander reports can attribute each constraint's effect.
 */
export interface PromptConstraint {
  id: string; // short slug, logged as a prompt_variant suffix
  text: string; // full sentence appended to the prompt
  probability: number; // chance per page of applying, in [0, 1]
}

export const GENERATION_CONSTRAINTS: readonly PromptConstraint[] = [
  {
    id: "no-library",
    // The self-reference guard ("does not speak of itself as a page…") used to
    // live here too, but that made it only ~75%-reliable; it is now an
    // always-on line in the base-v6 builder. This constraint is purely about
    // library *content* now, which is meant to stay probabilistic.
    text:
      "This particular page happens to contain no mention of libraries, " +
      "shelves, archives, librarians, or infinite collections of texts.",
    probability: 0.75,
  },
];

/**
 * Combinatorial form axes (base-v6). base-v5 restored register variety with a
 * top-down `register` axis that *named* the finished genre ("It is a customer
 * complaint."), so the model performed the genre — the source of genre
 * collisions and prompt-y pages. base-v6 drops register and steers only with
 * **low-level formal primitives**: tense, sentence rhythm, diction, perceptual
 * channel, specificity. None of them names a genre, so the genre *emerges*
 * from the combination rather than being declared — subtler, and effectively
 * collision-free.
 *
 * The bet (made deliberately, docs/reference/generation.md): these primitives
 * shape *how* the prose moves, not *what* it is, so they may not yank content
 * out of the models' literary-melancholy gravity well the way naming "a court
 * testimony" did. If a wander shows the range collapsing (as base-v4 did), the
 * fallback is to reintroduce a lower-level *occasion* steer, not the named
 * genre. Verified per-wander rather than assumed.
 *
 * Each axis is sampled independently by its own `applyProbability`, and when it
 * applies the seed picks one option; the axis renders that option as a plain
 * **fact about the found page** (never "reads like", never an order, and never
 * a subject/topic — only formal properties, so the subject-seed narration
 * anti-pattern stays avoided). Axes are frequently empty by design, and the
 * caller caps how many co-fire (lib/generate.ts MAX_AXES), so pages range from
 * bare to lightly specified and contrived over-specification stays impossible.
 *
 * The selection is address-seeded (lib/generate.ts), so the combination — and
 * the page — is a reproducible function of the coordinate.
 */
export interface PromptAxis {
  name: string; // short slug, logged in the seed_word provenance fingerprint
  applyProbability: number; // chance the axis contributes anything, in [0, 1]
  options: readonly string[];
  render: (option: string) => string; // option → a fact sentence
}

export const GENERATION_AXES: readonly PromptAxis[] = [
  {
    name: "pov",
    applyProbability: 0.3,
    render: (o) => `It is written in ${o}.`,
    options: [
      "the first person",
      "the second person",
      "a close third person",
      "an impersonal, institutional voice",
    ],
  },
  {
    name: "tense",
    applyProbability: 0.4,
    render: (o) => `Its verbs stay in ${o}.`,
    options: ["the present tense", "the past tense"],
  },
  {
    name: "cadence",
    applyProbability: 0.4,
    render: (o) => `Its sentences are ${o}.`,
    options: [
      "short and clipped",
      "long and flowing",
      "uneven — some clipped, some very long",
    ],
  },
  {
    name: "diction",
    applyProbability: 0.4,
    render: (o) => `Its diction is ${o}.`,
    options: [
      "plain and monosyllabic",
      "formal and latinate",
      "archaic",
      "clinical and precise",
    ],
  },
  {
    name: "sense",
    applyProbability: 0.3,
    render: (o) => `It attends most closely to ${o}.`,
    options: [
      "what is seen",
      "what is heard",
      "texture and touch",
      "smell and taste",
      "heat and cold",
    ],
  },
  {
    name: "specificity",
    applyProbability: 0.25,
    render: (o) => `It is ${o}.`,
    options: [
      "dense with proper names, dates, and numbers",
      "stripped of proper names, dates, and numbers",
    ],
  },
  {
    name: "structure",
    applyProbability: 0.3,
    render: (o) => `It is set down as ${o}.`,
    options: [
      "continuous prose",
      "a numbered list",
      "short discrete entries",
      "loose fragments",
      "a single unbroken paragraph",
      "a question-and-answer exchange",
    ],
  },
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
  // base-v2 plus the dynamic-constraint slot (GENERATION_CONSTRAINTS above).
  "base-v3": ({ maxWords, form, constraints = [] }) =>
    [
      "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
      "",
      [
        `The writing on this page reads like ${form}. It may be a brief fragment ` +
          `or fill the leaf, but no more than about ${maxWords} words, and it ` +
          "must read as a finished whole — never cut off mid-thought.",
        ...constraints,
      ].join(" "),
    ].join("\n"),
  // base-v4 drops the random form/register label entirely: no "reads like X"
  // steer. Prompt-side variety now rests on the constraint slot alone; the
  // rest comes from model mixing (docs/reference/generation.md). Lever
  // *selection* is address-seeded upstream (lib/generate.ts,
  // lib/seededRandom.ts) so the page is a function of its coordinate, but that
  // does not change the prompt text — only base-v4's shape does, hence the id.
  "base-v4": ({ maxWords, constraints = [] }) =>
    [
      "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
      "",
      [
        "The page may be a brief fragment or fill the leaf, but no more than " +
          `about ${maxWords} words, and it must read as a finished whole — ` +
          "never cut off mid-thought.",
        ...constraints,
      ].join(" "),
    ].join("\n"),
  // base-v5 = base-v4 plus the combinatorial form axes (GENERATION_AXES). The
  // caller assembles `facts` = rendered axis sentences + any constraint texts,
  // in order; the builder just appends them. No "reads like" label — each fact
  // is an observed property of the found page.
  "base-v5": ({ maxWords, facts = [] }) =>
    [
      "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
      "",
      [
        "The page may be a brief fragment or fill the leaf, but no more than " +
          `about ${maxWords} words, and it must read as a finished whole — ` +
          "never cut off mid-thought.",
        ...facts,
      ].join(" "),
    ].join("\n"),
  // base-v6 = base-v5's facts slot, but the axes are low-level formal
  // primitives (no named-genre register), and the self-reference guard is now
  // an always-on sentence rather than a probabilistic constraint clause — so
  // the "Page 47,821,903 of the Unbound Codex" self-titling tic can never slip
  // through. Facts (rendered axes + any constraint texts) still trail the size
  // clause in one paragraph.
  "base-v6": ({ maxWords, facts = [] }) =>
    [
      "An endless library holds every text that could ever be written. You are " +
        "reading one page from it; set down exactly what is on it. You do not " +
        "know what it is or where it sits.",
      "",
      [
        "The page may be a brief fragment or fill the leaf, but no more than " +
          `about ${maxWords} words, and it must read as a finished whole — ` +
          "never cut off mid-thought.",
        "It does not speak of itself as a page, give itself a page number, or " +
          "address whoever is reading it.",
        ...facts,
      ].join(" "),
    ].join("\n"),
  "book-v1": bookV1,
};

/**
 * Variants that carry the dynamic-constraint slot (GENERATION_CONSTRAINTS).
 * book-v1 pins its own register and takes no constraints; base-v2 predates the
 * slot. lib/generate.ts only samples constraints for a variant listed here.
 */
export const CONSTRAINT_VARIANTS: ReadonlySet<string> = new Set([
  "base-v3",
  "base-v4",
  "base-v5",
  "base-v6",
]);

/**
 * Variants that carry the combinatorial form axes (GENERATION_AXES).
 * lib/generate.ts only samples axes for a variant listed here.
 *
 * The axes are currently **paused**: base-v6 is the default variant but is
 * deliberately left out of this set, so the live library generates under
 * base-v6's prompt (always-on self-reference guard, the no-library constraint)
 * with no axis steering at all. The machinery — GENERATION_AXES, sampleAxes(),
 * the fingerprint — is intact; re-enable by adding "base-v6" back here.
 * base-v5 stays listed as frozen history (it is not the default).
 */
export const AXIS_VARIANTS: ReadonlySet<string> = new Set(["base-v5"]);

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

export const DEFAULT_PROMPT_VARIANT = "base-v6";

export const PROMPT_VARIANT_IDS = Object.keys(VARIANTS);

export function buildPrompt(variantId: string, ctx: PromptContext): string {
  const builder = VARIANTS[variantId];
  if (!builder) {
    throw new Error(`Unknown prompt variant: ${variantId}`);
  }
  return builder(ctx);
}
