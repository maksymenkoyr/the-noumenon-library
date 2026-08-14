"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { deriveScenes, warpTime, type SceneSpec } from "@/lib/composition";
import { markIntroSeen } from "@/lib/intro";
import { CompositionProvider, IntroScene } from "./intro-scene";
import { introMono } from "./intro-fonts";

/**
 * The intro shell: owns the single-pass playback clock and the
 * letterboxed 1080x1080 stage, and renders the skip button. IntroScene
 * (intro-scene.tsx) is the piece itself and knows nothing about any of
 * this — it only reads T/cues from CompositionProvider.
 *
 * Stands in for the prototype's much larger `Stage`/`CompositionStage`
 * (`Library of Babel animation/animations-v3.jsx`), which also carries a
 * scrub bar, localStorage playhead persistence, and an
 * `<svg><foreignObject>` wrapper that exists only so a frame can be
 * serialized for video export — none of which apply to playing the piece
 * once, in a browser, as a landing sequence.
 */

const STAGE_SIZE = 1080;

// OM_SCENES from Library of Babel animation/Library of Babel.dc.html.
// intro-scene.tsx's choreography is hand-timed against the authored cues
// this derives (see lib/composition.test.ts) — do not edit without
// re-checking that file.
const SCENES: SceneSpec[] = [
  { name: "Glyph", dur: 2.5, nat: 3.5 },
  { name: "Alphabet", dur: 4 },
  { name: "OneBook", dur: 3.3, nat: 5 },
  { name: "Pages", dur: 6.5, nat: 7.5 },
  { name: "Everything", dur: 2.8, nat: 5.5 },
  { name: "Close", dur: 4.5 },
];

const FADE_MS = 400;

type Phase = "playing" | "leaving" | "gone";

// Layout effects warn ("does nothing on the server") unless gated to the
// client; regular effects run too late to prevent a flash for the
// reduced-motion check and the letterbox scale below.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function Intro({
  onDone,
  force = false,
}: {
  // Fires once, whenever phase reaches "gone" — via the normal fade-out, a
  // skip, or the reduced-motion immediate-skip below. All three mean the
  // same thing to a caller (app/[[...address]]/intro-experience.tsx): the
  // overlay is gone now.
  onDone?: () => void;
  // Bypasses the reduced-motion check below. Set on a deliberate replay (a
  // reader who just clicked "play intro again") — reduced-motion is about
  // suppressing autoplay, not blocking a motion the reader just asked for.
  force?: boolean;
} = {}) {
  const derived = useMemo(() => deriveScenes(SCENES), []);
  const [time, setTime] = useState(0);
  const [scale, setScale] = useState(1);
  const [phase, setPhase] = useState<Phase>("playing");
  const skipRef = useRef<HTMLButtonElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  // Authoritative clock value for the RAF loop itself — setTime below is
  // for rendering (T = warpTime(derived, time)); reading `time` state back
  // in the same closure would be stale, so the loop tracks its own copy.
  const timeRef = useRef(0);
  // Latest `onDone`, kept outside the completion effect's own dependency
  // array below — IntroExperience passes an inline arrow, a fresh
  // reference every one of its own re-renders (including the one *caused*
  // by that callback firing), so depending on it directly would re-run the
  // effect right after completion and re-invoke it once more.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const dismiss = useCallback(() => {
    setPhase((p) => (p === "playing" ? "leaving" : p));
  }, []);

  // First-visit cookie: written on mount, not on completion/skip, so a
  // reload mid-intro doesn't replay it from the top.
  useEffect(() => {
    markIntroSeen();
  }, []);

  // Reduced motion: never start the clock. A layout effect so this lands
  // before the browser's first paint — a plain effect would let one frame
  // of the full intro through first. Skipped entirely when `force` is set
  // (see the prop doc above).
  useIsomorphicLayoutEffect(() => {
    if (!force && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setPhase("gone");
    }
  }, [force]);

  // Letterbox: scale-to-fit the 1080x1080 stage inside the viewport. Also
  // a layout effect, so the stage is correctly sized before first paint
  // instead of flashing at scale(1).
  useIsomorphicLayoutEffect(() => {
    const measure = () => {
      const s = Math.min(window.innerWidth / STAGE_SIZE, window.innerHeight / STAGE_SIZE);
      setScale(Math.max(0.05, s));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Clock: one pass, stops itself at derived.total. Completion is decided
  // right here in the RAF callback rather than in a separate effect — an
  // effect body calling setState synchronously on every render is a
  // cascading-render smell (react-hooks/set-state-in-effect); this is an
  // async callback the effect merely schedules, the same shape as the
  // setTime call two lines below that already lives here.
  useEffect(() => {
    if (phase !== "playing") return;
    lastTsRef.current = null;
    const step = (ts: number) => {
      if (lastTsRef.current == null) lastTsRef.current = ts;
      const dt = (ts - lastTsRef.current) / 1000;
      lastTsRef.current = ts;
      const next = Math.min(timeRef.current + dt, derived.total);
      timeRef.current = next;
      setTime(next);
      if (next >= derived.total) {
        dismiss();
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [phase, derived.total, dismiss]);

  // Body scroll lock while up; Esc dismisses.
  useEffect(() => {
    if (phase === "gone") return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dismiss();
      } else if (e.key === "Tab") {
        // The skip button is the only focusable control while the overlay
        // is up. Without this, Tab/Shift+Tab would reach nav/marks/report
        // controls hidden behind the opaque overlay (WCAG 2.4.3) — a
        // one-element focus trap is simplest as "always stay put".
        e.preventDefault();
        skipRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [phase, dismiss]);

  // Focus the skip button so keyboard/screen-reader users land on the one
  // control that matters immediately.
  useEffect(() => {
    if (phase === "playing") skipRef.current?.focus();
  }, [phase]);

  // Fade out, then unmount.
  useEffect(() => {
    if (phase !== "leaving") return;
    const id = setTimeout(() => setPhase("gone"), FADE_MS);
    return () => clearTimeout(id);
  }, [phase]);

  // Tell the caller once the overlay is actually gone — phase is a
  // one-way machine (playing -> leaving -> gone), so this fires exactly
  // once per mount regardless of which path got it there.
  useEffect(() => {
    if (phase === "gone") onDoneRef.current?.();
  }, [phase]);

  if (phase === "gone") return null;

  const T = warpTime(derived, time);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Intro animation"
      className={`intro-overlay ${introMono.variable}`}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        overflow: "hidden",
        background: "#07080b",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: phase === "leaving" ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        pointerEvents: phase === "leaving" ? "none" : "auto",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "relative",
          width: STAGE_SIZE,
          height: STAGE_SIZE,
          flexShrink: 0,
          transform: `scale(${scale})`,
          transformOrigin: "center",
        }}
      >
        <CompositionProvider T={T} cues={derived.cues}>
          <IntroScene />
        </CompositionProvider>
      </div>

      <button
        ref={skipRef}
        type="button"
        onClick={dismiss}
        className="rounded-sm font-mono text-[13px] tracking-wide text-[rgba(239,233,220,0.55)] outline-none hover:text-[rgba(239,233,220,0.9)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[rgba(169,182,200,0.65)]"
        style={{
          position: "fixed",
          left: "50%",
          bottom: 28,
          transform: "translateX(-50%)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "10px 6px",
        }}
      >
        skip intro →
      </button>
    </div>
  );
}
