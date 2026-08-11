import { describe, expect, it } from "vitest";
import { PixelCanvas } from "./pixelCanvas";

describe("PixelCanvas set/isLit", () => {
  it("reports a set cell as lit and everything else as unlit", () => {
    const c = new PixelCanvas(4, 4);
    c.set(1, 2);
    expect(c.isLit(1, 2)).toBe(true);
    expect(c.isLit(0, 0)).toBe(false);
    expect(c.isLit(2, 1)).toBe(false);
  });

  it("clears a cell when set with lit: false", () => {
    const c = new PixelCanvas(4, 4);
    c.set(1, 1);
    c.set(1, 1, false);
    expect(c.isLit(1, 1)).toBe(false);
  });

  it("treats out-of-bounds set() as a silent no-op", () => {
    const c = new PixelCanvas(4, 4);
    expect(() => c.set(-1, 0)).not.toThrow();
    expect(() => c.set(0, -1)).not.toThrow();
    expect(() => c.set(4, 0)).not.toThrow();
    expect(() => c.set(0, 4)).not.toThrow();
    expect(c.toRuns()).toEqual([]);
  });

  it("treats out-of-bounds isLit() as false rather than throwing", () => {
    const c = new PixelCanvas(4, 4);
    expect(c.isLit(-1, 0)).toBe(false);
    expect(c.isLit(100, 100)).toBe(false);
  });
});

describe("PixelCanvas line", () => {
  it("draws a horizontal line inclusive of both endpoints", () => {
    const c = new PixelCanvas(8, 2);
    c.line(1, 0, 4, 0);
    expect(c.toRuns()).toEqual([{ x: 1, y: 0, w: 4 }]);
  });

  it("draws a vertical line inclusive of both endpoints", () => {
    const c = new PixelCanvas(2, 8);
    c.line(0, 1, 0, 4);
    expect(c.toRuns()).toEqual([
      { x: 0, y: 1, w: 1 },
      { x: 0, y: 2, w: 1 },
      { x: 0, y: 3, w: 1 },
      { x: 0, y: 4, w: 1 },
    ]);
  });

  it("draws a clean 45-degree staircase, one pixel per row, none off-diagonal", () => {
    const c = new PixelCanvas(5, 5);
    c.line(0, 0, 3, 3);
    expect(c.toRuns()).toEqual([
      { x: 0, y: 0, w: 1 },
      { x: 1, y: 1, w: 1 },
      { x: 2, y: 2, w: 1 },
      { x: 3, y: 3, w: 1 },
    ]);
  });

  it("draws the shallow octant as a hand-verified Bresenham point set", () => {
    // dx=6, dy=2: two single-pixel steps in y across six pixels of x —
    // traced by hand against the generalized algorithm, not just asserted.
    const c = new PixelCanvas(8, 4);
    c.line(0, 0, 6, 2);
    const lit: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 2],
      [6, 2],
    ];
    lit.forEach(([x, y]) => expect(c.isLit(x, y)).toBe(true));
    // Exactly one lit cell per x in this range — a function, not a blob.
    expect(c.toRuns().reduce((n, r) => n + r.w, 0)).toBe(lit.length);
  });

  it("draws the same point set regardless of direction", () => {
    const forward = new PixelCanvas(5, 5);
    forward.line(0, 0, 3, 3);
    const backward = new PixelCanvas(5, 5);
    backward.line(3, 3, 0, 0);
    expect(backward.toRuns()).toEqual(forward.toRuns());
  });

  it("clips a line that runs off the grid instead of throwing or wrapping", () => {
    const c = new PixelCanvas(4, 4);
    expect(() => c.line(-2, -2, 2, 2)).not.toThrow();
    expect(c.isLit(0, 0)).toBe(true);
    expect(c.isLit(2, 2)).toBe(true);
    // Nothing from the off-grid half of the line lands elsewhere on the grid.
    expect(c.toRuns().reduce((n, r) => n + r.w, 0)).toBe(3); // (0,0) (1,1) (2,2)
  });
});

describe("PixelCanvas rect / fillRect", () => {
  it("draws a hollow outline, interior left unlit", () => {
    const c = new PixelCanvas(6, 6);
    c.rect(1, 1, 4, 4);
    expect(c.isLit(1, 1)).toBe(true); // corner
    expect(c.isLit(4, 1)).toBe(true); // corner
    expect(c.isLit(1, 4)).toBe(true); // corner
    expect(c.isLit(4, 4)).toBe(true); // corner
    expect(c.isLit(2, 1)).toBe(true); // top edge
    expect(c.isLit(1, 2)).toBe(true); // left edge
    expect(c.isLit(2, 2)).toBe(false); // interior
    expect(c.isLit(3, 3)).toBe(false); // interior
  });

  it("fills every cell of a solid rectangle", () => {
    const c = new PixelCanvas(6, 6);
    c.fillRect(1, 1, 3, 2);
    for (let y = 1; y < 3; y++) {
      for (let x = 1; x < 4; x++) expect(c.isLit(x, y)).toBe(true);
    }
    expect(c.isLit(4, 1)).toBe(false);
    expect(c.isLit(1, 3)).toBe(false);
  });
});

describe("PixelCanvas polygon", () => {
  it("closes a triangle, wrapping the last point back to the first", () => {
    const c = new PixelCanvas(6, 6);
    c.polygon([
      [0, 0],
      [4, 0],
      [0, 4],
    ]);
    // Every declared vertex is lit...
    expect(c.isLit(0, 0)).toBe(true);
    expect(c.isLit(4, 0)).toBe(true);
    expect(c.isLit(0, 4)).toBe(true);
    // ...and so is the closing edge back from (0,4) to (0,0), not just the
    // two edges you'd get from an open polyline.
    expect(c.isLit(0, 2)).toBe(true);
    // The interior stays hollow.
    expect(c.isLit(1, 1)).toBe(false);
  });
});

describe("PixelCanvas hatch", () => {
  it("repeats a stroke count times, each offset by the step vector", () => {
    const c = new PixelCanvas(10, 10);
    c.hatch(0, 0, 2, 0, 0, 2, 3); // 3 short horizontal strokes, stepping down by 2
    expect(c.toRuns()).toEqual([
      { x: 0, y: 0, w: 3 },
      { x: 0, y: 2, w: 3 },
      { x: 0, y: 4, w: 3 },
    ]);
  });
});
