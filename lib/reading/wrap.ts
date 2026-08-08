/**
 * Word-wrap simulation matching the rendered page's CSS: `whitespace-pre-wrap`
 * (app/[[...address]]/page-content.tsx:20), no `overflow-wrap` set anywhere on
 * `<article>`. See ./layout.ts for where `charsPerLine` comes from.
 *
 * `pre-wrap` semantics this function reproduces:
 *   - every `\n` in the source is a hard break (an empty line still occupies a
 *     line box);
 *   - within a paragraph, wrap greedily at space boundaries to the measure;
 *   - leading spaces are preserved and count toward the measure — pre-wrap
 *     does not collapse them the way normal white-space does;
 *   - a single token longer than the measure is not broken (no
 *     `overflow-wrap: anywhere`/`break-word`): it overflows onto one line.
 */

import type { PageSnapshot, Renderer, ViewportProfile } from "./layout.ts";
import { charsPerLine, foldLines } from "./layout.ts";

/** Wrap one hard-broken line (no embedded \n) to `measure` columns. */
function wrapLine(line: string, measure: number): string[] {
  if (line.length === 0) return [""];
  // Tokenize on runs of spaces, keeping the spaces as their own tokens so
  // leading/interior spacing is preserved verbatim when reassembled.
  const tokens = line.match(/ +|[^ ]+/g) ?? [];
  const out: string[] = [];
  let current = "";

  for (const token of tokens) {
    if (current.length === 0) {
      // Start of a visual line: a token longer than the measure overflows
      // rather than breaking (no overflow-wrap set on the article).
      current = token;
      continue;
    }
    if (current.length + token.length <= measure) {
      current += token;
      continue;
    }
    // Doesn't fit. A trailing space that would have pushed us over simply
    // drops at the wrap point (browsers collapse a trailing wrapped space);
    // anything else starts the next visual line.
    if (token.trim() === "") {
      out.push(current);
      current = "";
      continue;
    }
    out.push(current);
    current = token;
  }
  out.push(current);
  return out;
}

/** Wrap full page text to the viewport profile's measure. One entry per
 * rendered line box, in reading order — the unit `./stages.ts` slices on. */
export function wrapText(text: string, profile: ViewportProfile): string[] {
  const measure = charsPerLine(profile);
  const hardLines = text.split("\n");
  return hardLines.flatMap((line) => wrapLine(line, measure));
}

/**
 * The renderer used today: computed wrapping, no browser. `address` is
 * accepted-but-unused — it exists solely so a future `browserRenderer` (same
 * `Renderer` shape, navigating to the real page and reading true line boxes)
 * is a drop-in replacement with no signature change anywhere it's called.
 */
export const simulatedRenderer: Renderer = {
  async render(text: string, _address: string, profile: ViewportProfile): Promise<PageSnapshot> {
    const lines = wrapText(text, profile);
    // A short page never reaches its own fold; clamp so `foldLine` is always
    // a valid index into `lines` (or exactly `lines.length`).
    const foldLine = Math.min(foldLines(profile), lines.length);
    return { lines, foldLine, profile };
  },
};
