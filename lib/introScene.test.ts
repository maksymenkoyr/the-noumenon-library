import { describe, expect, it } from "vitest";
import { PixelCanvas } from "./pixelCanvas";
import {
  STAGE_SIZE,
  drawOpenSpread,
  drawPulledBook,
  drawShelf,
  drawTextPage,
  shelfLayout,
} from "./introScene";

function litCount(canvas: PixelCanvas): number {
  return canvas.toRuns().reduce((n, r) => n + r.w, 0);
}

describe("shelfLayout", () => {
  it("places books left to right with no overlap, in a world wider than the stage", () => {
    const { books, worldWidth } = shelfLayout();
    expect(books.length).toBeGreaterThan(0);
    for (let i = 1; i < books.length; i++) {
      expect(books[i].x).toBeGreaterThan(books[i - 1].x + books[i - 1].w);
    }
    // The whole point of a scroll loop: there must be more shelf than one
    // screenful, or panning would just show the same books immediately.
    expect(worldWidth).toBeGreaterThan(STAGE_SIZE * 2);
  });
});

describe("drawShelf", () => {
  it("draws something", () => {
    const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawShelf(c, 0);
    expect(litCount(c)).toBeGreaterThan(0);
  });

  it("loops seamlessly: scrolling by exactly one world width reproduces the same frame", () => {
    const layout = shelfLayout();
    const a = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    const b = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawShelf(a, 0, layout);
    drawShelf(b, layout.worldWidth, layout);
    expect(b.toRuns()).toEqual(a.toRuns());
  });

  it("produces a different frame at a different scroll position", () => {
    const layout = shelfLayout();
    const a = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    const b = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawShelf(a, 0, layout);
    drawShelf(b, 40, layout);
    expect(b.toRuns()).not.toEqual(a.toRuns());
  });
});

describe("drawPulledBook", () => {
  it("changes the frame relative to a plain shelf at the same scroll position", () => {
    const layout = shelfLayout();
    const plain = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    const pulled = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawShelf(plain, 0, layout);
    drawPulledBook(pulled, 0, layout.books[0].index, layout);
    expect(pulled.toRuns()).not.toEqual(plain.toRuns());
  });

  it("does nothing beyond the plain shelf for an index that doesn't exist", () => {
    const layout = shelfLayout();
    const plain = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    const pulled = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawShelf(plain, 0, layout);
    drawPulledBook(pulled, 0, 9999, layout);
    expect(pulled.toRuns()).toEqual(plain.toRuns());
  });
});

describe("drawOpenSpread", () => {
  it("clears whatever was behind the page before drawing it, so a blank page reads as opaque paper", () => {
    // (30, 30) is well inside the left page's interior once flat (t=1) —
    // far from the 1px outline border, so only the clear step can explain
    // it going unlit.
    const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    c.set(30, 30);
    drawOpenSpread(c, 1);
    expect(c.isLit(30, 30)).toBe(false);
  });

  it("leaves points outside the current page's bounds untouched", () => {
    // Same point, but at t=0 the oblique page is small and sits lower and
    // to the right — (30, 30) is nowhere near it, so the clear must not
    // reach that far.
    const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    c.set(30, 30);
    drawOpenSpread(c, 0);
    expect(c.isLit(30, 30)).toBe(true);
  });

  it("never throws across the full t range, including out-of-domain values", () => {
    [-0.5, 0, 0.25, 0.5, 0.75, 1, 1.5].forEach((t) => {
      const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
      expect(() => drawOpenSpread(c, t)).not.toThrow();
    });
  });
});

describe("drawTextPage", () => {
  it("draws the left page's drop cap, not just a bare outline", () => {
    const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawTextPage(c);
    // FLAT_SPREAD's left page starts at x=12 (center 80 - gap/2 2 - halfW
    // 66), yTop=14; drawParagraph insets 6px and starts the drop cap 5px
    // below its header rule — so the drop cap's top-left corner is (18, 29).
    expect(c.isLit(18, 29)).toBe(true);
  });

  it("draws paragraph lines filling most of the page height, not just a header rule", () => {
    const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawTextPage(c);
    const midPageLines = c.toRuns().filter((r) => r.y > 100 && r.y < 140);
    expect(midPageLines.length).toBeGreaterThan(3);
  });
});
