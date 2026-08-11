/**
 * Pixel-art frames — the shared primitive behind the first-visit intro and,
 * later, the crystallizing-wait animation (docs/reference/experience.md).
 *
 * A frame is 1-bit: authored as plain text art, one row per string, `#` for
 * a lit cell and anything else for an unlit one. No shading, no gradient — a
 * cell is on or off, and transitions between frames are hard cuts, never
 * tweened.
 *
 * `runs()` merges each row into horizontal pixel runs before rendering, so a
 * wide silhouette becomes a few hundred SVG rects instead of one per cell.
 * The merge itself is shared with lib/pixelCanvas.ts (a drawn buffer, for
 * geometry text art can't express) via lib/pixelRuns.ts.
 */

import { mergeRowRuns, type PixelRun } from "./pixelRuns";

export type { PixelRun };
export type Frame = readonly string[];

const LIT = "#";

/**
 * One rect-friendly run per contiguous stretch of lit cells in each row. Row
 * lengths may be ragged — a shorter row is simply narrower, not padded.
 */
export function runs(frame: Frame): PixelRun[] {
  const out: PixelRun[] = [];
  frame.forEach((row, y) => {
    mergeRowRuns(y, row.length, (x) => row[x] === LIT, out);
  });
  return out;
}
