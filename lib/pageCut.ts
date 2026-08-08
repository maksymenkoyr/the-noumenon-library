/**
 * Where the page stops — computed, not asked for.
 *
 * The prompt used to state the length twice ("Generate 400 words… At 400 words
 * it runs out of room and stops mid-sentence"). Probing that against a live
 * model returned 531, 503, 724 and 777 words for a 400-word target: +26% to
 * +94%. Models cannot count, and the "runs out of room" phrasing appears to
 * make it worse by implying more text exists. One run leaked the instruction
 * into the page ("…with a kiln-related element. Word count: approximately
 * 400.").
 *
 * So the ending stopped being a request. The model is asked for *more* text
 * than the page holds, and the page is cut here — deterministically, from the
 * text it actually produced. The governing split: **prompt what the model can
 * do, compute what it can't.** It can start mid-sentence on demand (that lever
 * lives in lib/prompts.ts and is obeyed); it cannot stop on a word count.
 *
 * This does not add truncation to the system — it replaces an accident with a
 * decision. Every model_registry generation row caps at `max_tokens = 1000`
 * (~750 words), and the two longest probe runs came back at 973 and 948
 * tokens, i.e. against the cap. The library was already cutting pages off
 * mid-word; it just had no idea it was doing it.
 *
 * Pure and synchronous: no config, no network, no clock. The caller supplies
 * the page size (lib/generate.ts, from config.pageWords).
 */

/** How the page stops. Drawn per page and persisted as provenance. */
export type Ending = "cut-hard" | "cut-soft" | "complete";

export interface EndingOption {
  id: Ending;
  weight: number;
}

/**
 * `cut-hard` and `cut-soft` both render as a *full* page that breaks off; they
 * differ only in how jagged the bottom edge is. Together they are 85% of the
 * library.
 *
 * `complete` is held deliberately low. It is the one ending where the model
 * chooses its own stopping point, and left to itself it writes a self-contained
 * literary vignette that wraps itself up — the exact default register the
 * entropy dials exist to push against. It is kept at all because a real book
 * does have short pages (a chapter close, a poem), and because a wander of
 * nothing but severed pages has no rhythm.
 */
export const ENDINGS: readonly EndingOption[] = [
  { id: "cut-hard", weight: 60 },
  { id: "cut-soft", weight: 25 },
  { id: "complete", weight: 15 },
];

/** Weighted draw from the ending pool, off the caller's seeded stream. */
export function pickEnding(rng: () => number): EndingOption {
  const total = ENDINGS.reduce((sum, o) => sum + o.weight, 0);
  let r = rng() * total;
  for (const option of ENDINGS) {
    r -= option.weight;
    if (r <= 0) return option;
  }
  return ENDINGS[ENDINGS.length - 1]; // floating-point rounding fallback
}

/**
 * How far back `cut-soft` will search for a sentence boundary. Sentences run
 * ~18 words, so a boundary almost always sits within this window and the cut
 * lands just short of a full page. When one doesn't — a long unbroken passage,
 * a list, dialogue without terminators — falling back to `cut-hard` is better
 * than emitting a visibly short page and calling it full.
 */
const SOFT_LOOKBACK_WORDS = 40;

/** A word and where it sits in the source text. */
interface Word {
  text: string;
  start: number;
  end: number;
}

/**
 * Whitespace-delimited runs, matching how word counts are taken everywhere
 * else in the codebase (`split(/\s+/)`), so a page reported as N words is N
 * words by the same measure the tests and reports use.
 */
function words(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** True for a word that closes a sentence — allowing a trailing quote or bracket. */
function endsSentence(word: string): boolean {
  return /[.!?][)\]"'”’]*$/.test(word);
}

/**
 * Strip the narrator's gesture from both edges. Left alone the model marks an
 * abrupt seam with a leading or trailing ellipsis, which says *this is an
 * excerpt* — an apology for where the page ends. Real paper doesn't apologize.
 *
 * The prompt also asks for this, but a cut can expose one the prompt never saw
 * (an ellipsis mid-text that the cut lands on), so it is enforced here rather
 * than hoped for. Also drops a bracket or quote left dangling at the very end
 * by a cut — those read as a rendering bug rather than a page break.
 *
 * The dangling rule requires whitespace before the mark, so it only fires on a
 * mark standing alone with nothing after it. `"` and `'` are ambiguous, and an
 * attached one is a closer: a page ending `she said "go home."` must keep its
 * quote, while one ending `she said "` must not.
 */
function trimSeams(text: string): string {
  return text
    .replace(TITLE, "")
    .replace(/^\s*(?:\.{2,}|…)\s*/, "")
    .replace(/\s*(?:\.{2,}|…)\s*$/, "")
    .replace(/\s+[([{"'‘“]$/, "")
    .trim();
}

/**
 * A title the model gave itself, as a Markdown heading or a lone bold line.
 *
 * Four pages in ten opened with one — `# The Warehouse`, `# Ammunition and
 * Aftermath`, and, memorably, `# Mid-Paragraph Fragment`, the model titling the
 * page after the instruction it had just been given. A page of a book has no
 * H1, and a title flatly contradicts a page that is supposed to begin
 * mid-sentence.
 *
 * The old `self-reference` constraint used to suppress this (it stopped pages
 * titling themselves "Page 47,821,903 of the Unbound Codex") and was deleted
 * along with the premise that caused it. The habit came back through a
 * different door, so it is handled here instead of costing prompt words: in
 * every observed case the requested seam was honoured *underneath* the title,
 * so removing the title alone leaves a correct page.
 *
 * Requires whitespace after the hashes, so a page opening "#3 was missing"
 * survives, and requires the line to end — a heading is a line, not a sentence.
 */
const TITLE = /^\s*(?:#{1,6}\s+.*|\*\*.+\*\*)(?:\r?\n)+/;

export interface CutResult {
  /** The page as it will be moderated, hashed, and stored. */
  text: string;
  /** Word count after cutting — what the reader actually gets. */
  words: number;
  /** Whether a cut fired. False when the model came up short of the page. */
  cut: boolean;
}

/**
 * Cut at exactly `pageWords`. `midToken` slices into the final word so the page
 * breaks mid-word, the way a real page break lands wherever it lands. Kept rare
 * by its caller: it is the most true to paper and the most likely to be read as
 * a broken generation.
 */
function cutHard(all: Word[], text: string, pageWords: number, midToken: boolean): string {
  const last = all[pageWords - 1];
  if (!midToken) return text.slice(0, last.end);
  // Leave a fragment of at least two characters, and never the whole word —
  // a "mid-word" break that lands on a word boundary isn't one.
  if (last.text.length < 4) return text.slice(0, last.end);
  return text.slice(0, last.start + Math.ceil(last.text.length / 2));
}

/**
 * Cut back to the last sentence boundary at or before `pageWords`, so the
 * sentence completes but the paragraph does not — the commonest way a real page
 * reads: no jagged edge, yet plainly unfinished. Returns null when no boundary
 * sits within SOFT_LOOKBACK_WORDS, leaving the caller to fall back to a hard cut.
 */
function cutSoft(all: Word[], text: string, pageWords: number): string | null {
  const floor = Math.max(0, pageWords - SOFT_LOOKBACK_WORDS);
  for (let i = pageWords - 1; i >= floor; i--) {
    if (endsSentence(all[i].text)) return text.slice(0, all[i].end);
  }
  return null;
}

/**
 * Apply the drawn ending to generated text, returning what should be stored.
 *
 * Text shorter than the page passes through untouched under every ending — the
 * model came up short, and there is nothing to cut. That is the one case where
 * leftover whitespace on screen means a weak generation rather than a choice.
 *
 * `complete` is not cut, since the whole point of it is that the text reaches
 * its own end. It is still bounded: a "complete" text that overruns the page
 * would render past the container, so it gets a soft cut as a backstop.
 */
export function applyEnding(
  raw: string,
  ending: Ending,
  pageWords: number,
): CutResult {
  const text = trimSeams(raw);
  const all = words(text);
  if (all.length <= pageWords) {
    return { text, words: all.length, cut: false };
  }

  let cutText: string;
  if (ending === "cut-hard") {
    // Mid-word on a fifth of hard cuts. Derived from the text itself rather
    // than drawn, so it needs no extra lever and stays reproducible: the same
    // stored page always cuts the same way.
    const midToken = all[pageWords - 1].text.length % 5 === 0;
    cutText = cutHard(all, text, pageWords, midToken);
  } else {
    cutText = cutSoft(all, text, pageWords) ?? cutHard(all, text, pageWords, false);
  }

  const trimmed = trimSeams(cutText);
  return { text: trimmed, words: words(trimmed).length, cut: true };
}
