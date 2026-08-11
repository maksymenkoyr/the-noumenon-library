/**
 * A drawable 1-bit pixel buffer — the primitive behind the first-visit
 * intro's shelf scene (lib/introScene.ts), where the geometry has real
 * diagonals (an oblique 3/4 view) that hand-authored text-art frames
 * (lib/pixelArt.ts) can't express.
 *
 * Every cell is on or off, nothing in between: `set()` writes a boolean, not
 * a weight, so drawing a shape twice is identical to drawing it once — there
 * is no way to accidentally build a shade by overlapping strokes. Lines are
 * Bresenham (integer-only), so a diagonal is a clean staircase of whole
 * pixels, never an anti-aliased slope.
 */

import { mergeRowRuns, type PixelRun } from "./pixelRuns";

export type { PixelRun };

export class PixelCanvas {
  readonly width: number;
  readonly height: number;
  private readonly data: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height);
  }

  /** Turns one cell on (default) or off. Out-of-bounds is a silent no-op —
      geometry that drifts off the grid should clip, not throw. */
  set(x: number, y: number, lit = true): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= this.width || yi < 0 || yi >= this.height) return;
    this.data[yi * this.width + xi] = lit ? 1 : 0;
  }

  isLit(x: number, y: number): boolean {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= this.width || yi < 0 || yi >= this.height) return false;
    return this.data[yi * this.width + xi] !== 0;
  }

  /** Bresenham's line algorithm, generalized to all octants and both
      directions. Endpoints are always included. */
  line(x0: number, y0: number, x1: number, y1: number, lit = true): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xEnd = Math.round(x1);
    const yEnd = Math.round(y1);
    const dx = Math.abs(xEnd - x);
    const sx = x < xEnd ? 1 : -1;
    const dy = -Math.abs(yEnd - y);
    const sy = y < yEnd ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x, y, lit);
      if (x === xEnd && y === yEnd) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y += sy;
      }
    }
  }

  /** A hollow rectangle outline, `w`×`h`, top-left at (x, y). */
  rect(x: number, y: number, w: number, h: number, lit = true): void {
    this.line(x, y, x + w - 1, y, lit);
    this.line(x, y + h - 1, x + w - 1, y + h - 1, lit);
    this.line(x, y, x, y + h - 1, lit);
    this.line(x + w - 1, y, x + w - 1, y + h - 1, lit);
  }

  /** A solid rectangle — used sparingly (e.g. the shelf board's front lip);
      most shapes in this style are hollow outlines. */
  fillRect(x: number, y: number, w: number, h: number, lit = true): void {
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    const x1 = x0 + Math.round(w);
    const y1 = y0 + Math.round(h);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.set(xx, yy, lit);
    }
  }

  /** A closed polygon outline through the given points, wrapping from the
      last point back to the first. */
  polygon(points: ReadonlyArray<readonly [number, number]>, lit = true): void {
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[(i + 1) % points.length];
      this.line(x0, y0, x1, y1, lit);
    }
  }

  /**
   * `count` parallel copies of one stroke, each offset from the last by
   * (stepX, stepY) — the only texture this style allows, since there is no
   * dithered fill. Uses the same delta-vector idiom as the scene's oblique
   * projection rather than an angle, so a hatch across a skewed face steps
   * along that face's own depth vector exactly, with no trig involved.
   */
  hatch(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    stepX: number,
    stepY: number,
    count: number,
    lit = true,
  ): void {
    for (let i = 0; i < count; i++) {
      this.line(x0 + stepX * i, y0 + stepY * i, x1 + stepX * i, y1 + stepY * i, lit);
    }
  }

  /** Merges the buffer into horizontal runs, row by row — same merge core
      lib/pixelArt.ts's runs() uses, so a drawn scene renders exactly as
      cheaply as a hand-authored frame. */
  toRuns(): PixelRun[] {
    const out: PixelRun[] = [];
    for (let y = 0; y < this.height; y++) {
      const rowStart = y * this.width;
      mergeRowRuns(y, this.width, (x) => this.data[rowStart + x] !== 0, out);
    }
    return out;
  }
}
