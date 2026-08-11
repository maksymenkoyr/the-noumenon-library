/**
 * Dev-only: renders the first-visit intro's shelf sequence straight out of
 * the real lib/pixelCanvas.ts + lib/introScene.ts into one self-contained
 * HTML file, for reviewing the geometry before it's wired into
 * app/[[...address]]/intro.tsx. Every pixel in the output comes from calling
 * the actual shipping functions — nothing here re-implements or
 * approximates them, so what gets reviewed is the real art code.
 *
 * Not part of the app or its build; not wired into package.json's scripts
 * on purpose (its one dependency, jiti, is transitive — pulled in by
 * something else in node_modules, not a project devDependency).
 *
 * Run with:
 *   node_modules/.bin/jiti scripts/render-intro-frames.ts [output-path.html]
 */

import { writeFileSync } from "node:fs";
import { PixelCanvas, type PixelRun } from "../lib/pixelCanvas";
import {
  STAGE_SIZE,
  drawOpenSpread,
  drawPulledBook,
  drawShelf,
  drawTextPage,
  shelfLayout,
} from "../lib/introScene";

const outPath = process.argv[2] ?? "intro-storyboard-review.html";

const layout = shelfLayout();

// Panel 1: the pan loop. Sampled every few world pixels rather than every
// one — this file previews the geometry, not final timing (that's tuned
// live in intro.tsx, which calls drawShelf with the exact fractional
// scrollX every animation frame, and so is always smoother than any
// pre-baked sampling here could be). [0, worldWidth) loops seamlessly with
// no duplicate frame at the seam — confirmed by lib/introScene.test.ts.
const PAN_STEP = 3;
const pan: PixelRun[][] = [];
for (let x = 0; x < layout.worldWidth; x += PAN_STEP) {
  const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
  drawShelf(c, x, layout);
  pan.push(c.toRuns());
}

// The book that gets pulled, opened, and pushed in — tall, upright, and
// decorated, so it reads clearly as the one the sequence settles on. The
// scroll position that centers it is reused by every frame from here on,
// so the shelf doesn't visibly jump behind the book between panels.
const HERO_INDEX = 6;
const heroBook = layout.books.find((b) => b.index === HERO_INDEX);
if (!heroBook) throw new Error(`No book at index ${HERO_INDEX} — check BOOK_TABLE in lib/introScene.ts`);
const settleScrollX = heroBook.x + heroBook.w / 2 - STAGE_SIZE / 2;

// Panel 2: pulled forward, still in the row. One hard-cut frame.
const pulledCanvas = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
drawPulledBook(pulledCanvas, settleScrollX, HERO_INDEX, layout);
const pulled = pulledCanvas.toRuns();

// Panels 3-4: the open spread, pushing in and flattening. The one
// continuous animation in this style — sampled densely enough (31 steps)
// to play smoothly.
const OPEN_STEPS = 31;
const openSweep: PixelRun[][] = [];
for (let i = 0; i < OPEN_STEPS; i++) {
  const t = i / (OPEN_STEPS - 1);
  const c = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
  drawOpenSpread(c, t, settleScrollX, HERO_INDEX);
  openSweep.push(c.toRuns());
}

// Panel 5's content: the flat page with placeholder text.
const textCanvas = new PixelCanvas(STAGE_SIZE, STAGE_SIZE);
drawTextPage(textCanvas);
const text = textCanvas.toRuns();

const totalBytes =
  JSON.stringify(pan).length +
  JSON.stringify(pulled).length +
  JSON.stringify(openSweep).length +
  JSON.stringify(text).length;
console.log(
  `pan: ${pan.length} frames · openSweep: ${openSweep.length} frames · ` +
    `payload: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`,
);

const DATA = JSON.stringify({ stageSize: STAGE_SIZE, pan, pulled, openSweep, text });

const html = `<title>Intro storyboard review — real geometry, no bundler</title>
<style>
  :root {
    --bg: #101114; --surface: #17181c; --surface-2: #1d1f24;
    --ink: #ecece3; --muted: #93938c; --line: rgba(255,255,255,0.1);
    --accent: #c9a15a; --stage-bg: #000000; --stage-fg: #f5f5f2;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #edece6; --surface: #ffffff; --surface-2: #f5f4ef;
      --ink: #1b1b17; --muted: #6e6e67; --line: rgba(0,0,0,0.1); --accent: #8c6a2e;
    }
  }
  :root[data-theme="light"] {
    --bg: #edece6; --surface: #ffffff; --surface-2: #f5f4ef;
    --ink: #1b1b17; --muted: #6e6e67; --line: rgba(0,0,0,0.1); --accent: #8c6a2e;
  }
  :root[data-theme="dark"] {
    --bg: #101114; --surface: #17181c; --surface-2: #1d1f24;
    --ink: #ecece3; --muted: #93938c; --line: rgba(255,255,255,0.1); --accent: #c9a15a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: ui-serif, Georgia, "Iowan Old Style", "Times New Roman", serif;
    line-height: 1.55;
  }
  .page { max-width: 40rem; margin: 0 auto; padding: 3rem 1.5rem 4rem; display: flex; flex-direction: column; gap: 1.5rem; }
  .mono { font-family: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace; }
  .eyebrow { margin: 0; font-size: 0.75rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); }
  h1 { margin: 0; font-size: clamp(1.4rem, 1.1rem + 1.3vw, 1.9rem); font-weight: 500; line-height: 1.25; text-wrap: balance; max-width: 30ch; }
  .lede { margin: 0; max-width: 62ch; font-size: 1rem; color: var(--muted); }
  .controls-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.9rem 1.5rem; padding: 0.9rem 1.1rem; background: var(--surface); border: 1px solid var(--line); }
  .switch { display: inline-flex; align-items: center; gap: 0.6rem; cursor: pointer; user-select: none; }
  .switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .switch-track { width: 2.1rem; height: 1.1rem; background: var(--surface-2); border: 1px solid var(--line); position: relative; flex-shrink: 0; }
  .switch-track::before { content: ""; position: absolute; top: 2px; left: 2px; width: 0.75rem; height: 0.75rem; background: var(--muted); }
  .switch input:checked + .switch-track { border-color: var(--accent); }
  .switch input:checked + .switch-track::before { left: calc(100% - 0.75rem - 2px); background: var(--accent); }
  .switch input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .switch-label { font-size: 0.8rem; letter-spacing: 0.04em; text-transform: uppercase; }
  .reel { background: var(--surface); border: 1px solid var(--line); padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
  .plaque { margin: 0; font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
  .screen { background: var(--stage-bg); padding: clamp(0.6rem, 3%, 1.1rem); border: 1px solid var(--line); }
  .stage-wrap { aspect-ratio: 1 / 1; width: 100%; max-width: 26rem; margin: 0 auto; }
  .pixel-svg { width: 100%; height: 100%; display: block; color: var(--stage-fg); }
  .pixel-svg rect { fill: currentColor; }
  .reel-foot { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; }
  .caption { margin: 0; font-size: 0.8rem; color: var(--muted); min-width: 16ch; }
  .btn { font-family: inherit; font: inherit; font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; padding: 0.55rem 0.9rem; background: transparent; color: var(--ink); border: 1px solid var(--accent); cursor: pointer; }
  .btn:hover { background: var(--surface-2); }
  .btn:active { transform: translateY(1px); }
  .panel-key { margin: 0; font-size: 0.85rem; color: var(--muted); display: flex; flex-wrap: wrap; gap: 0.4rem 1.2rem; }
  .panel-key b { color: var(--ink); font-weight: 500; }
  .footer-note { margin: 0; font-size: 0.82rem; color: var(--muted); max-width: 62ch; }
  .footer-note code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.85em; background: var(--surface-2); padding: 0.1em 0.35em; border: 1px solid var(--line); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

<main class="page">
  <p class="eyebrow mono">Storyboard review · real geometry</p>
  <h1>Not a mockup — this is lib/introScene.ts, rendered</h1>
  <p class="lede">Every frame below came from calling the actual <code class="mono">drawShelf</code> / <code class="mono">drawPulledBook</code> / <code class="mono">drawOpenSpread</code> / <code class="mono">drawTextPage</code> in the repo — pre-sampled here rather than run live only because a browser can't import TypeScript directly. Nothing was redrawn by hand for this preview.</p>

  <div class="controls-bar">
    <label class="switch">
      <input type="checkbox" id="reduced-toggle" />
      <span class="switch-track" aria-hidden="true"></span>
      <span class="switch-label mono">Reduced motion</span>
    </label>
    <p class="caption" style="margin:0;">Your system's own motion preference is honored automatically too.</p>
  </div>

  <section class="reel">
    <p class="plaque mono">The reel</p>
    <div class="screen">
      <div class="stage-wrap">
        <svg viewBox="0 0 ${STAGE_SIZE} ${STAGE_SIZE}" shape-rendering="crispEdges" class="pixel-svg" id="stage-svg" aria-hidden="true"></svg>
      </div>
    </div>
    <div class="reel-foot">
      <p class="caption mono" id="caption">panning the shelf…</p>
      <button class="btn" id="btn-ready" type="button">Simulate page ready</button>
    </div>
    <p class="panel-key"><b>1</b> shelf pans <b>2</b> pulled, still in the row <b>3–4</b> opens, pushes in, flattens <b>5</b> flat page (border/expand is intro.tsx's job, not drawn here)</p>
  </section>

  <p class="footer-note">Pan sampled every ${PAN_STEP} world-px (real timing is tuned later, live, in <code>intro.tsx</code>) — ${pan.length} frames. Open/flatten sweep: ${openSweep.length} frames across t=0→1. Generated by <code>scripts/render-intro-frames.ts</code>.</p>
</main>

<script>
  var DATA = ${DATA};
</script>
<script>
  (function () {
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.getElementById("stage-svg");
    var caption = document.getElementById("caption");
    var btn = document.getElementById("btn-ready");
    var reducedToggle = document.getElementById("reduced-toggle");
    var reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    function render(runs) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      var frag = document.createDocumentFragment();
      for (var i = 0; i < runs.length; i++) {
        var r = runs[i];
        var rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", r.x);
        rect.setAttribute("y", r.y);
        rect.setAttribute("width", r.w);
        rect.setAttribute("height", 1);
        frag.appendChild(rect);
      }
      svg.appendChild(frag);
    }

    var PAN_INTERVAL_MS = 70;
    var OPEN_INTERVAL_MS = 80;
    var PULLED_HOLD_MS = 550;
    var TEXT_HOLD_MS = 1200;

    var timer = null;
    function clear() {
      if (timer) { clearTimeout(timer); clearInterval(timer); timer = null; }
    }

    function reducedActive() { return reducedToggle.checked; }

    function playPan() {
      clear();
      caption.textContent = reducedActive() ? "waiting… (reduced motion)" : "panning the shelf…";
      if (reducedActive()) { render(DATA.pan[0]); return; }
      var i = 0;
      render(DATA.pan[i]);
      timer = setInterval(function () {
        i = (i + 1) % DATA.pan.length;
        render(DATA.pan[i]);
      }, PAN_INTERVAL_MS);
    }

    function playOpenSweep(onDone) {
      var i = 0;
      function step() {
        render(DATA.openSweep[i]);
        i++;
        if (i >= DATA.openSweep.length) { onDone(); return; }
        timer = setTimeout(step, OPEN_INTERVAL_MS);
      }
      step();
    }

    function playSequence() {
      clear();
      if (reducedActive()) {
        render(DATA.text);
        caption.textContent = "resolved — page ready";
        btn.textContent = "Replay";
        return;
      }
      caption.textContent = "pulling it out…";
      render(DATA.pulled);
      timer = setTimeout(function () {
        caption.textContent = "opening, pushing in…";
        playOpenSweep(function () {
          render(DATA.text);
          caption.textContent = "resolved — page ready";
          btn.textContent = "Replay";
        });
      }, PULLED_HOLD_MS);
    }

    btn.addEventListener("click", function () {
      if (btn.textContent === "Replay") { btn.textContent = "Simulate page ready"; playPan(); return; }
      playSequence();
    });
    reducedToggle.addEventListener("change", playPan);
    reduceQuery.addEventListener("change", function (e) { reducedToggle.checked = e.matches; playPan(); });
    reducedToggle.checked = reduceQuery.matches;

    playPan();
  })();
</script>
`;

writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
