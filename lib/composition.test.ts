import { describe, expect, it } from "vitest";
import {
  Easing,
  animate,
  clamp,
  deriveScenes,
  interpolate,
  warpTime,
  type SceneSpec,
} from "./composition";

// The actual intro scene list (app/[[...address]]/intro.tsx), copied from
// OM_SCENES in `Library of Babel animation/Library of Babel.dc.html`. The
// choreography in intro-scene.tsx is hand-timed against the authored cues
// this list derives — Glyph 0, Alphabet 3.5, OneBook 7.5, Pages 12.5,
// Everything 20, Close 25.5 — so this pins the contract that timing depends
// on. If this list changes, every hardcoded time in intro-scene.tsx (e.g.
// the text locks at 20.4, the final fade at 29.0) needs re-checking too.
const SCENES: SceneSpec[] = [
  { name: "Glyph", dur: 2.5, nat: 3.5 },
  { name: "Alphabet", dur: 4 },
  { name: "OneBook", dur: 3.3, nat: 5 },
  { name: "Pages", dur: 6.5, nat: 7.5 },
  { name: "Everything", dur: 2.8, nat: 5.5 },
  { name: "Close", dur: 4.5 },
];

describe("deriveScenes", () => {
  it("derives cumulative authored cue times from the intro scene list", () => {
    const d = deriveScenes(SCENES);
    expect(d.cues).toEqual({
      Glyph: 0,
      Alphabet: 3.5,
      OneBook: 7.5,
      Pages: 12.5,
      Everything: 20,
      Close: 25.5,
    });
  });

  it("totals playback and authored duration separately", () => {
    const d = deriveScenes(SCENES);
    expect(d.total).toBeCloseTo(23.6, 6);
    expect(d.authoredTotal).toBe(30);
  });

  it("defaults a scene's authored duration to its playback duration when nat is omitted", () => {
    const d = deriveScenes([{ name: "Glyph", dur: 4 }]);
    expect(d.sections[0].nat).toBe(4);
    expect(d.authoredTotal).toBe(4);
  });

  it("keys a cue to the first occurrence of a repeated scene name", () => {
    const d = deriveScenes([
      { name: "Glyph", dur: 1 },
      { name: "Alphabet", dur: 1 },
      { name: "Glyph", dur: 1 },
    ]);
    expect(d.cues.Glyph).toBe(0);
  });
});

describe("warpTime", () => {
  const d = deriveScenes(SCENES);

  it("is 0 at the start of playback and authoredTotal at the end", () => {
    expect(warpTime(d, 0)).toBe(0);
    expect(warpTime(d, d.total)).toBe(d.authoredTotal);
  });

  it("is monotonically non-decreasing across playback", () => {
    let prev = -Infinity;
    for (let t = 0; t <= d.total; t += 0.1) {
      const T = warpTime(d, t);
      expect(T).toBeGreaterThanOrEqual(prev);
      prev = T;
    }
  });

  it("lands exactly on each scene's authored cue at its playback boundary", () => {
    // Halfway through Glyph's playback duration, half its authored duration
    // should have elapsed (linear warp within a scene).
    expect(warpTime(d, 1.25)).toBeCloseTo(1.75, 6);
    // The start of OneBook's playback window is exactly its authored cue.
    expect(warpTime(d, d.sections[2].playStart)).toBeCloseTo(d.cues.OneBook, 6);
  });
});

describe("interpolate", () => {
  it("is exact at keyframes", () => {
    const fn = interpolate([0, 0.5, 1], [0, 100, 50]);
    expect(fn(0)).toBe(0);
    expect(fn(0.5)).toBe(100);
    expect(fn(1)).toBe(50);
  });

  it("clamps below the first and above the last keyframe", () => {
    const fn = interpolate([1, 2, 3], [10, 20, 30]);
    expect(fn(0)).toBe(10);
    expect(fn(4)).toBe(30);
  });

  it("applies a per-segment easing array", () => {
    const fn = interpolate([0, 1, 2], [0, 1, 2], [Easing.easeInOutCubic, (t) => t]);
    // Second segment is linear, so its midpoint is exact.
    expect(fn(1.5)).toBeCloseTo(1.5, 6);
  });
});

describe("animate", () => {
  it("holds from/to outside the [start, end] window", () => {
    const fn = animate({ from: 0, to: 1, start: 1, end: 2 });
    expect(fn(0)).toBe(0);
    expect(fn(3)).toBe(1);
  });

  it("eases between from and to inside the window", () => {
    const fn = animate({ from: 0, to: 10, start: 0, end: 1, ease: (t) => t });
    expect(fn(0.5)).toBeCloseTo(5, 6);
  });
});

describe("clamp", () => {
  it("clamps to the given range", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
