/**
 * Dev-only: rasterizes lib/introScene.ts frames straight to PNG via sharp,
 * so they can actually be looked at — by a human, or by Claude via the Read
 * tool — instead of only reasoned about mathematically (coordinate math and
 * unit tests catch real bugs, as they did for the gap/skew overlap, but
 * they're not a substitute for seeing the thing). A PixelCanvas is already
 * just a flat on/off pixel buffer, so this needs no SVG and no browser —
 * sharp is a transitive dependency already in node_modules (pulled in by
 * something else, likely Next's own image optimization), not a project
 * devDependency; this is dev tooling, not part of the app.
 *
 * Run with:
 *   node_modules/.bin/jiti scripts/render-intro-png.ts [output-dir]
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PixelCanvas, type PixelRun } from "../lib/pixelCanvas";
import {
  STAGE_SIZE,
  drawOpenSpread,
  drawPulledBook,
  drawShelf,
  drawTextPage,
  shelfLayout,
} from "../lib/introScene";

const SCALE = 6; // nearest-neighbor upscale so individual pixels are visible

function toPixelBuffer(runs: readonly PixelRun[], width: number, height: number): Buffer {
  const buf = Buffer.alloc(width * height, 0); // 0 = black
  runs.forEach((r) => {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (x < 0 || x >= width || r.y < 0 || r.y >= height) continue;
      buf[r.y * width + x] = 255; // white
    }
  });
  return buf;
}

async function savePng(runs: readonly PixelRun[], name: string, outDir: string): Promise<void> {
  const raw = toPixelBuffer(runs, STAGE_SIZE, STAGE_SIZE);
  const outPath = path.join(outDir, `${name}.png`);
  await sharp(raw, { raw: { width: STAGE_SIZE, height: STAGE_SIZE, channels: 1 } })
    .resize(STAGE_SIZE * SCALE, STAGE_SIZE * SCALE, { kernel: "nearest" })
    .png()
    .toFile(outPath);
  console.log("wrote", outPath);
}

async function main(): Promise<void> {
  const outDir = process.argv[2] ?? ".";
  mkdirSync(outDir, { recursive: true });

  const layout = shelfLayout();

  const shelfCanvas = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
  drawShelf(shelfCanvas, 0, layout);
  await savePng(shelfCanvas.toRuns(), "01-shelf", outDir);

  const HERO_INDEX = 6;
  const heroBook = layout.books.find((b) => b.index === HERO_INDEX);
  if (!heroBook) throw new Error(`No book at index ${HERO_INDEX}`);
  const settleScrollX = heroBook.x + heroBook.w / 2 - STAGE_SIZE / 2;

  const pulledCanvas = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
  drawPulledBook(pulledCanvas, settleScrollX, HERO_INDEX, layout);
  await savePng(pulledCanvas.toRuns(), "02-pulled", outDir);

  const openSteps = [0, 0.3, 0.6, 1];
  for (let i = 0; i < openSteps.length; i++) {
    const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
    drawOpenSpread(c, openSteps[i], settleScrollX, HERO_INDEX);
    await savePng(c.toRuns(), `03-open-t${openSteps[i]}`, outDir);
  }

  const textCanvas = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
  drawTextPage(textCanvas);
  await savePng(textCanvas.toRuns(), "04-text", outDir);
}

main();
