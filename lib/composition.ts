/**
 * Timeline math for the intro animation (app/[[...address]]/intro.tsx and
 * intro-scene.tsx), ported from the `animations-v3.jsx` composition engine
 * in `Library of Babel animation/` (a design-tool prototype, not shipped).
 *
 * The prototype's full engine also carries a scrub bar, a tweaks panel, an
 * edit-mode host protocol, and SVG/video-export scaffolding — none of which
 * belongs in the app. This module is the pure slice the scene actually
 * computes with: keyframe interpolation, easing, and the two-clock model
 * that lets a piece be authored on one time axis ("authored seconds", T)
 * while playing back on a shorter one (wall-clock seconds).
 *
 * Ported from (for future comparison against the source prototype):
 *   Easing            <- animations-v3.jsx Easing (subset actually used)
 *   clamp              <- animations-v3.jsx clamp
 *   interpolate        <- animations-v3.jsx interpolate
 *   animate            <- animations-v3.jsx animate
 *   deriveScenes       <- animations-v3.jsx ccDerive
 *   warpTime           <- animations-v3.jsx ccWarp
 *
 * Deliberately dropped: the prototype's `ccCueProxy`, which turns a
 * reference to an unknown scene name into `NaN` plus a preview-only warning
 * badge (useful mid-authoring, when scene names are still being renamed).
 * Here `SceneName` is a closed string-literal union and `cues` a
 * `Record<SceneName, number>`, so the same mistake is a compile error
 * instead of a silent NaN at playback time.
 */

export type SceneName =
  | "Glyph"
  | "Alphabet"
  | "OneBook"
  | "Pages"
  | "Everything"
  | "Close";

export interface SceneSpec {
  name: SceneName;
  /** Wall-clock (playback) seconds this scene occupies. */
  dur: number;
  /** Authored seconds this scene occupies; defaults to `dur` (no warp). */
  nat?: number;
}

interface Section {
  name: SceneName;
  playStart: number;
  dur: number;
  authStart: number;
  nat: number;
}

export interface DerivedComposition {
  sections: Section[];
  /** Authored start time of each scene, keyed by name (first occurrence wins). */
  cues: Record<SceneName, number>;
  /** Total wall-clock (playback) duration, seconds. */
  total: number;
  /** Total authored duration, seconds — the axis choreography is keyed to. */
  authoredTotal: number;
}

/** t ∈ [0,1] -> eased t ∈ [0,1]; only the easings `babel-scene.jsx` reaches. */
export const Easing = {
  easeInOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutCubic: (t: number) => (--t) * t * t + 1,
  easeInOutCubic: (t: number) =>
    t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
};

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * interpolate([0, 0.5, 1], [0, 100, 50], ease?) -> fn(t)
 * Linearly maps t across input keyframes to output values, with optional
 * easing per segment (a single fn, or one fn per segment). Clamps to the
 * first/last output outside the keyframe range.
 */
export function interpolate(
  input: number[],
  output: number[],
  ease: ((t: number) => number) | ((t: number) => number)[] = Easing.easeInOutSine,
): (t: number) => number {
  return (t: number) => {
    if (t <= input[0]) return output[0];
    if (t >= input[input.length - 1]) return output[output.length - 1];
    for (let i = 0; i < input.length - 1; i++) {
      if (t >= input[i] && t <= input[i + 1]) {
        const span = input[i + 1] - input[i];
        const local = span === 0 ? 0 : (t - input[i]) / span;
        const easeFn = Array.isArray(ease) ? ease[i] || Easing.easeInOutSine : ease;
        const eased = easeFn(local);
        return output[i] + (output[i + 1] - output[i]) * eased;
      }
    }
    return output[output.length - 1];
  };
}

/** animate({from, to, start, end, ease})(t) — a single-segment tween. */
export function animate({
  from = 0,
  to = 1,
  start = 0,
  end = 1,
  ease = Easing.easeInOutCubic,
}: {
  from?: number;
  to?: number;
  start?: number;
  end?: number;
  ease?: (t: number) => number;
}): (t: number) => number {
  return (t: number) => {
    if (t <= start) return from;
    if (t >= end) return to;
    const local = (t - start) / (end - start);
    return from + (to - from) * ease(local);
  };
}

/**
 * Turns the authored scene list (playback duration `dur` + optional
 * authored duration `nat` per scene) into cumulative cue times and the two
 * totals `warpTime` maps between.
 */
export function deriveScenes(scenes: SceneSpec[]): DerivedComposition {
  let playStart = 0;
  let authStart = 0;
  const sections: Section[] = [];
  const cues = {} as Record<SceneName, number>;
  for (const s of scenes) {
    const nat = typeof s.nat === "number" && isFinite(s.nat) && s.nat > 0 ? s.nat : s.dur;
    sections.push({ name: s.name, playStart, dur: s.dur, authStart, nat });
    if (!(s.name in cues)) {
      cues[s.name] = Math.round(authStart * 1000) / 1000;
    }
    playStart += s.dur;
    authStart += nat;
  }
  return {
    sections,
    cues,
    total: Math.round(playStart * 1000) / 1000,
    authoredTotal: Math.round(authStart * 1000) / 1000,
  };
}

/** Maps a wall-clock playback second `t` onto the authored time axis. */
export function warpTime(d: DerivedComposition, t: number): number {
  const ss = d.sections;
  if (ss.length === 0) return 0;
  let idx = ss.length - 1;
  for (let i = 0; i < ss.length; i++) {
    if (t < ss[i].playStart + ss[i].dur) {
      idx = i;
      break;
    }
  }
  const s = ss[idx];
  const local = Math.min(Math.max(t - s.playStart, 0), s.dur);
  const T = s.authStart + (s.dur > 0 ? local * (s.nat / s.dur) : 0);
  return Math.min(T, d.authoredTotal);
}
