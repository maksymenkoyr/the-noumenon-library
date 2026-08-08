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
 */

export type Frame = readonly string[];

export interface PixelRun {
  x: number;
  y: number;
  w: number;
}

const LIT = "#";

/**
 * One rect-friendly run per contiguous stretch of lit cells in each row. Row
 * lengths may be ragged — a shorter row is simply narrower, not padded.
 */
export function runs(frame: Frame): PixelRun[] {
  const out: PixelRun[] = [];
  frame.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== LIT) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === LIT) x++;
      out.push({ x: start, y, w: x - start });
    }
  });
  return out;
}
