/**
 * Geometry for the first-visit intro's shelf scene (app/[[...address]]/intro.tsx
 * draws these into an SVG; app/[[...address]]/introFrames.ts's hand-authored
 * text-art frames are retired in favor of this — the storyboard's 3/4 view has
 * real diagonals no text grid can express).
 *
 * The sequence, from the storyboard: a shelf pans (drawShelf) → settles and
 * one book steps forward, still in the row (drawPulledBook) → it opens into a
 * blank spread in front of the shelf, which stays visible behind it, pushing
 * in and flattening toward the camera (drawOpenSpread(t)) → the flattened
 * spread gets its placeholder text (drawTextPage). Everything is 1-bit,
 * hollow outlines only — no dithered fill. Only the push-in/flatten in
 * drawOpenSpread is meant to run as a continuous animation; every other
 * transition between these is a hard cut.
 *
 * Projection is oblique, not true perspective: every book is a front face
 * (the spine, facing the camera) plus a top face offset by one fixed SKEW
 * vector. A real vanishing point would make foreshortening depend on a
 * book's x position, so the shelf would visibly warp as it pans and
 * couldn't loop; a fixed skew is pan-invariant, so the endless shelf stays
 * correct and seamless. It also matches how the storyboard is drawn.
 */

import { PixelCanvas } from "./pixelCanvas";

/** Both the intro's SVG viewBox and every PixelCanvas built for it. */
export const STAGE_SIZE = 160;

/** The top face's offset from the front face — the one number every skewed
    shape in this file derives from, so the whole scene reads as one
    consistent camera angle. */
export const SKEW = { dx: 8, dy: -5 } as const;

const SHELF_Y = 134; // books' front faces stand on this line
const BOARD_THICKNESS = 4;
const SPINE_GAP = 5;
const SHELF_MARGIN = 10;

export type Emblem = "none" | "diamond" | "circle";

export interface BookSpec {
  readonly w: number;
  readonly h: number;
  /** Horizontal shift of the top edge relative to the bottom, in pixels;
      0 = upright. A few nonzero entries in BOOK_TABLE below, per the
      storyboard's "a few books leaning". */
  readonly lean: number;
  readonly emblem: Emblem;
  readonly ribbed: boolean;
}

export interface PlacedBook extends BookSpec {
  readonly index: number;
  readonly x: number; // front face's bottom-left corner, in world space
  readonly yTop: number; // front face's top edge before lean is applied
}

export interface ShelfLayout {
  readonly books: readonly PlacedBook[];
  readonly worldWidth: number;
}

// Widths/heights in the same range v3 used and already proved legible at
// this grid size; lean, emblem and ribbing add the storyboard's variety.
const BOOK_TABLE: readonly BookSpec[] = [
  { w: 16, h: 88, lean: 0, emblem: "diamond", ribbed: false },
  { w: 22, h: 64, lean: 0, emblem: "none", ribbed: true },
  { w: 14, h: 102, lean: 0, emblem: "none", ribbed: false },
  { w: 26, h: 72, lean: -5, emblem: "circle", ribbed: false },
  { w: 19, h: 92, lean: 0, emblem: "none", ribbed: true },
  { w: 16, h: 58, lean: 0, emblem: "none", ribbed: false },
  { w: 22, h: 108, lean: 0, emblem: "diamond", ribbed: false },
  { w: 14, h: 78, lean: 4, emblem: "none", ribbed: true },
  { w: 19, h: 66, lean: 0, emblem: "circle", ribbed: false },
  { w: 26, h: 96, lean: 0, emblem: "none", ribbed: false },
  { w: 16, h: 84, lean: 0, emblem: "none", ribbed: true },
  { w: 22, h: 60, lean: -4, emblem: "diamond", ribbed: false },
  { w: 14, h: 100, lean: 0, emblem: "none", ribbed: false },
  { w: 19, h: 74, lean: 0, emblem: "circle", ribbed: true },
  { w: 16, h: 94, lean: 0, emblem: "none", ribbed: false },
  { w: 22, h: 70, lean: 0, emblem: "diamond", ribbed: true },
  { w: 14, h: 86, lean: 5, emblem: "none", ribbed: false },
];

export function shelfLayout(): ShelfLayout {
  const books: PlacedBook[] = [];
  let cursor = SHELF_MARGIN;
  BOOK_TABLE.forEach((spec, index) => {
    books.push({ ...spec, index, x: cursor, yTop: SHELF_Y - spec.h });
    cursor += spec.w + SPINE_GAP;
  });
  return { books, worldWidth: cursor + SHELF_MARGIN };
}

/** The leaning front face's horizontal offset at height-fraction `f` down
    from the top (f=0 at yTop, where the offset is the full lean; f=1 at
    yBot, where it's back to 0) — every detail placed on a leaning spine
    (bands, emblem, ribbing) derives its x from this, rather than each
    re-deriving its own approximation of the same slope. */
function leanOffsetAt(lean: number, f: number): number {
  return lean * (1 - f);
}

function drawDiamond(canvas: PixelCanvas, cx: number, cy: number): void {
  canvas.polygon([
    [cx, cy - 3],
    [cx + 3, cy],
    [cx, cy + 3],
    [cx - 3, cy],
  ]);
}

function drawCircle(canvas: PixelCanvas, cx: number, cy: number): void {
  // A hand-set octagon reads as a circle at this pixel scale — a true
  // midpoint-circle algorithm is overkill for a 5px emblem.
  canvas.polygon([
    [cx - 1, cy - 2],
    [cx + 1, cy - 2],
    [cx + 2, cy - 1],
    [cx + 2, cy + 1],
    [cx + 1, cy + 2],
    [cx - 1, cy + 2],
    [cx - 2, cy + 1],
    [cx - 2, cy - 1],
  ]);
}

function drawBook(canvas: PixelCanvas, x: number, yTop: number, book: BookSpec): void {
  const { w, h, lean, emblem, ribbed } = book;
  const yBot = yTop + h;

  // Front face: bottom edge fixed (it sits on the shelf), top edge shifted
  // by `lean` — a parallelogram when leaning, a plain rect when upright.
  const bottomLeft: [number, number] = [x, yBot];
  const bottomRight: [number, number] = [x + w, yBot];
  const topRight: [number, number] = [x + w + lean, yTop];
  const topLeft: [number, number] = [x + lean, yTop];
  canvas.polygon([bottomLeft, bottomRight, topRight, topLeft]);

  // Top face: the same top edge, extruded back by SKEW — the page-block
  // showing above the spine.
  const backRight: [number, number] = [topRight[0] + SKEW.dx, topRight[1] + SKEW.dy];
  const backLeft: [number, number] = [topLeft[0] + SKEW.dx, topLeft[1] + SKEW.dy];
  canvas.polygon([topLeft, topRight, backRight, backLeft]);

  // Page-block hatching: short strokes parallel to the top edge, stepped
  // back along the skew vector — the only texture this style allows.
  const hatchInset = Math.min(3, Math.floor(w / 4));
  canvas.hatch(
    topLeft[0] + hatchInset + SKEW.dx * 0.2,
    topLeft[1] + SKEW.dy * 0.2,
    topRight[0] - hatchInset + SKEW.dx * 0.2,
    topRight[1] + SKEW.dy * 0.2,
    SKEW.dx / 3,
    SKEW.dy / 3,
    3,
  );

  // Spine bands, following the lean so they read as wrapped around the
  // spine rather than painted flat over it.
  const bandFractions = h > 70 ? [0.16, 0.3] : [0.18];
  bandFractions.forEach((f) => {
    const by = yTop + h * f;
    const bx = x + leanOffsetAt(lean, f);
    canvas.line(bx + 2, by, bx + w - 3, by);
  });

  if (emblem !== "none") {
    const ef = 0.55;
    const ex = x + w / 2 + leanOffsetAt(lean, ef);
    const ey = yTop + h * ef;
    if (emblem === "diamond") drawDiamond(canvas, ex, ey);
    else drawCircle(canvas, ex, ey);
  }

  if (ribbed && w > 16) {
    const rf = 0.68;
    const ry0 = yTop + h * rf;
    const ry1 = ry0 + 6;
    const rx = x + leanOffsetAt(lean, rf);
    [4, 8].forEach((dx) => {
      if (dx < w - 4) canvas.line(rx + dx, ry0, rx + dx, ry1);
    });
  }
}

function drawShelfBoard(canvas: PixelCanvas, x0: number, x1: number, y: number): void {
  canvas.fillRect(x0, y, x1 - x0, BOARD_THICKNESS);
  // A thin top-face sliver at a shallower fraction of SKEW than a book's
  // (the board is thin, not a deep object) — echoes the same camera angle
  // rather than pasting a flat strip behind a tilted scene.
  const k = 0.4;
  canvas.polygon([
    [x0, y],
    [x1, y],
    [x1 + SKEW.dx * k, y + SKEW.dy * k],
    [x0 + SKEW.dx * k, y + SKEW.dy * k],
  ]);
}

// Generous — a leaning, skewed book's true bounds extend a bit past its own
// (x, w); culling is a performance nicety here (PixelCanvas.set() already
// clips silently), so over-including costs nothing but a few wasted draws.
const CULL_PAD = 40;

function drawShelfBooks(
  canvas: PixelCanvas,
  scrollX: number,
  layout: ShelfLayout,
  omitIndex?: number,
): void {
  const { books, worldWidth } = layout;
  const sx = ((scrollX % worldWidth) + worldWidth) % worldWidth;
  books.forEach((book) => {
    if (book.index === omitIndex) return;
    // The shelf wraps, so a book near either end may need drawing at up to
    // three candidate screen offsets, worldWidth apart.
    [book.x - sx, book.x - sx + worldWidth, book.x - sx - worldWidth].forEach((screenX) => {
      if (screenX + book.w < -CULL_PAD || screenX > canvas.width + CULL_PAD) return;
      drawBook(canvas, screenX, book.yTop, book);
    });
  });
}

/** Panel 1: the shelf, panning. `scrollX` is world-space pixels scrolled;
    the shelf loops seamlessly regardless of its value. */
export function drawShelf(
  canvas: PixelCanvas,
  scrollX: number,
  layout: ShelfLayout = shelfLayout(),
): void {
  drawShelfBooks(canvas, scrollX, layout);
  drawShelfBoard(canvas, -SKEW.dx, canvas.width + SKEW.dx, SHELF_Y);
}

/** Panel 2: the pan has settled and `pulledIndex` steps forward, still
    seated among its neighbors — a hard cut from drawShelf, not an
    in-between animated state (this style hard-cuts between states; only
    drawOpenSpread's push-in is continuous). "Forward, toward the camera" is
    the reverse of the direction a top face recedes, so the shift reuses
    SKEW itself rather than a new constant. */
export function drawPulledBook(
  canvas: PixelCanvas,
  scrollX: number,
  pulledIndex: number,
  layout: ShelfLayout = shelfLayout(),
): void {
  drawShelfBooks(canvas, scrollX, layout, pulledIndex);
  drawShelfBoard(canvas, -SKEW.dx, canvas.width + SKEW.dx, SHELF_Y);

  const book = layout.books.find((b) => b.index === pulledIndex);
  if (!book) return;
  const sx = ((scrollX % layout.worldWidth) + layout.worldWidth) % layout.worldWidth;
  const screenX = book.x - sx;
  drawBook(canvas, screenX - SKEW.dx, book.yTop - SKEW.dy, book);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

const SPREAD_CENTER_X = STAGE_SIZE / 2;

// The two endpoints drawOpenSpread(t) interpolates between: still part of
// the tilted 3D scene (small, low in frame, shelf visible above) at t=0,
// flat and frontal (large, fills the stage) at t=1. drawTextPage reuses
// FLAT directly, so its geometry always matches exactly where t=1 leaves off.
const OBLIQUE_SPREAD = { yTop: 96, yBot: 150, halfW: 30, gap: 3 };
const FLAT_SPREAD = { yTop: 14, yBot: 146, halfW: 66, gap: 4 };

function spreadHalves(cfg: { halfW: number; gap: number }) {
  return {
    leftX0: SPREAD_CENTER_X - cfg.gap / 2 - cfg.halfW,
    leftX1: SPREAD_CENTER_X - cfg.gap / 2,
    rightX0: SPREAD_CENTER_X + cfg.gap / 2,
    rightX1: SPREAD_CENTER_X + cfg.gap / 2 + cfg.halfW,
  };
}

function drawPage(
  canvas: PixelCanvas,
  x0: number,
  x1: number,
  yTop: number,
  yBot: number,
  shiftX: number,
  shiftY: number,
): void {
  // A page is opaque paper, not a wireframe: clear its bounding box first
  // (a hollow outline alone would let whatever's behind it — the shelf —
  // show straight through), then draw the outline on top of the clear.
  // The box, not the exact quadrilateral, so a bit more shelf disappears
  // right at a tilted page's slanted edge — imperceptible at this grid size.
  const left = Math.min(x0, x0 + shiftX) - 1;
  const right = Math.max(x1, x1 + shiftX) + 1;
  const top = Math.min(yTop, yTop + shiftY) - 1;
  canvas.fillRect(left, top, right - left, yBot - top + 1, false);

  canvas.polygon([
    [x0, yBot],
    [x1, yBot],
    [x1 + shiftX, yTop + shiftY],
    [x0 + shiftX, yTop + shiftY],
  ]);
}

/** Panels 3→4: the open spread, still blank. `t` runs 0 (just opened,
    oblique, shelf visible above it) to 1 (flat, frontal, filling the
    stage) — the one continuous animation in this style, everything else is
    a hard cut. The shelf is drawn every time regardless of `t`; it isn't
    faded out, it's simply covered more as the growing pages occlude it,
    matching the storyboard's shelf-still-visible-behind panels without any
    opacity trick. */
export function drawOpenSpread(canvas: PixelCanvas, t: number, scrollX = 0): void {
  drawShelf(canvas, scrollX);

  const yTop = lerp(OBLIQUE_SPREAD.yTop, FLAT_SPREAD.yTop, t);
  const yBot = lerp(OBLIQUE_SPREAD.yBot, FLAT_SPREAD.yBot, t);
  const halfW = lerp(OBLIQUE_SPREAD.halfW, FLAT_SPREAD.halfW, t);
  const gap = lerp(OBLIQUE_SPREAD.gap, FLAT_SPREAD.gap, t);
  const { leftX0, leftX1, rightX0, rightX1 } = spreadHalves({ halfW, gap });
  // A gentler tilt than a book's own top face (0.5×) — a page lying near-flat
  // in front of the shelf, not standing up like a spine.
  const shiftX = SKEW.dx * (1 - t) * 0.5;
  const shiftY = SKEW.dy * (1 - t) * 0.5;

  drawPage(canvas, leftX0, leftX1, yTop, yBot, shiftX, shiftY);
  drawPage(canvas, rightX0, rightX1, yTop, yBot, shiftX, shiftY);
  const valleyX = leftX1 + (rightX0 - leftX1) / 2;
  canvas.line(valleyX + shiftX, yTop + shiftY, valleyX, yBot);
}

function drawParagraph(
  canvas: PixelCanvas,
  left: number,
  right: number,
  top: number,
  bottom: number,
  dropCap: boolean,
): void {
  canvas.line(left, top, right, top); // header rule
  let ly = top + 5;
  if (dropCap) {
    canvas.rect(left, ly, 4, 4);
    canvas.line(left + 6, ly, right, ly);
    canvas.line(left + 6, ly + 3, right - 3, ly + 3);
    ly += 8;
  }
  const raggeds = [0, 3, 1, 5, 2, 0, 4, 1, 3, 0, 2, 5, 1];
  let li = 0;
  while (ly < bottom) {
    if (li % 6 === 5) {
      ly += 3;
      li++;
      continue;
    }
    canvas.line(left, ly, right - raggeds[li % raggeds.length], ly);
    ly += 3;
    li++;
  }
}

/** Panel 5's content: the fully flat spread, with placeholder paragraph
    text — what the intro hands off into once the surrounding square expands
    into the real page's border. Shares FLAT_SPREAD and drawPageOutline with
    drawOpenSpread(1) exactly, so there's no size jump at the cut between
    them. */
export function drawTextPage(canvas: PixelCanvas): void {
  const { leftX0, leftX1, rightX0, rightX1 } = spreadHalves(FLAT_SPREAD);
  const { yTop, yBot } = FLAT_SPREAD;
  drawPage(canvas, leftX0, leftX1, yTop, yBot, 0, 0);
  drawPage(canvas, rightX0, rightX1, yTop, yBot, 0, 0);
  const valleyX = leftX1 + (rightX0 - leftX1) / 2;
  canvas.line(valleyX, yTop, valleyX, yBot);

  drawParagraph(canvas, leftX0 + 6, leftX1 - 6, yTop + 10, yBot - 8, true);
  drawParagraph(canvas, rightX0 + 6, rightX1 - 6, yTop + 10, yBot - 8, false);
}
