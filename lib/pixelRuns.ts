/**
 * The row-merge core shared by lib/pixelArt.ts (hand-authored text-art
 * frames, rows of ragged string length) and lib/pixelCanvas.ts (a drawn
 * fixed-width buffer). Both need the same thing — walk one row left to
 * right, turn contiguous lit cells into a run — so it lives once here
 * instead of twice.
 */

export interface PixelRun {
  x: number;
  y: number;
  w: number;
}

/**
 * Scans one row of the given `width`, appending a run to `out` for each
 * contiguous stretch where `isLit(x)` is true. `width` is a parameter
 * (rather than fixed grid-wide) because pixelArt.ts's rows are ragged —
 * each row of a Frame may be a different length.
 */
export function mergeRowRuns(
  y: number,
  width: number,
  isLit: (x: number) => boolean,
  out: PixelRun[],
): void {
  let x = 0;
  while (x < width) {
    if (!isLit(x)) {
      x++;
      continue;
    }
    const start = x;
    while (x < width && isLit(x)) x++;
    out.push({ x: start, y, w: x - start });
  }
}
