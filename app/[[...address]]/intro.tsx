"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { runs, type Frame } from "@/lib/pixelArt";
import { markIntroSeen } from "@/lib/introSeen";
import { INTRO_IDLE_FRAMES, INTRO_OPENING_FRAMES } from "./introFrames";
import {
  getPageArrivedServerSnapshot,
  getPageArrivedSnapshot,
  subscribePageArrived,
} from "./introSignal";

// Per-frame delay before the *next* frame in the opening sequence, plus a
// final hold on the resolved frame before auto-dismissing. Hand-tuned: quick
// riffle through the tower and stars, a longer beat once the frame closes.
const OPENING_STEP_DELAYS_MS = [110, 130, 160, 190, 220, 700];
const REDUCED_MOTION_HOLD_MS = 700;

function FrameLayer({
  frame,
  className,
  style,
}: {
  frame: Frame;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <g className={className} style={style}>
      {runs(frame).map((r) => (
        <rect key={`${r.x}-${r.y}-${r.w}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </g>
  );
}

/**
 * The first-visit intro: a scene assembling itself in 1-bit pixel art while
 * the visitor's first page crystallizes (docs/reference/experience.md;
 * app/[[...address]]/introFrames.ts owns the actual frames).
 *
 * Always mounted, for every visitor — visibility for returning visitors is
 * handled entirely by CSS (`html[data-intro-seen] .intro-overlay`, set by a
 * blocking inline script in app/layout.tsx before hydration; see
 * lib/introSeen.ts) rather than by conditional rendering here, so this
 * component's own JSX never has to differ between server and client.
 *
 * Two phases: an idle loop (pure CSS, runs however long generation takes —
 * no ceiling) and a one-shot opening sequence, JS-stepped like the approved
 * prototype rather than driven by CSS keyframes, once PageArrivedSignal
 * reports the real page is on screen. Dismissible at any moment by a click
 * or a keypress; otherwise ends on its own a beat after the frame closes.
 */
export function Intro() {
  const arrived = useSyncExternalStore(
    subscribePageArrived,
    getPageArrivedSnapshot,
    getPageArrivedServerSnapshot,
  );
  const [dismissed, setDismissed] = useState(false);
  const [openingIndex, setOpeningIndex] = useState(-1); // -1 = still idle
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function dismiss() {
    if (timerRef.current) clearTimeout(timerRef.current);
    markIntroSeen();
    setDismissed(true);
  }

  // Idle -> opening, once the real page arrives. Runs at most once per page
  // load (arrived only ever flips false -> true).
  useEffect(() => {
    if (!arrived || dismissed) return;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      timerRef.current = setTimeout(dismiss, REDUCED_MOTION_HOLD_MS);
      return () => {
        if (timerRef.current) clearTimeout(timerRef.current);
      };
    }

    // i starts before frame 0 so the first frame is also set from inside the
    // timeout callback (async), not synchronously in the effect body.
    let i = -1;
    const step = () => {
      timerRef.current = setTimeout(
        () => {
          i += 1;
          if (i >= INTRO_OPENING_FRAMES.length) {
            dismiss();
            return;
          }
          setOpeningIndex(i);
          step();
        },
        i < 0 ? 0 : OPENING_STEP_DELAYS_MS[i],
      );
    };
    step();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // dismiss() only touches refs/a state setter — safe to omit; this must
    // fire exactly once, on the arrived transition, not on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);

  // Dismissible by any keypress, from anywhere — the overlay is decorative
  // (aria-hidden) and never requires interaction, so nothing needs focus.
  useEffect(() => {
    if (dismissed) return;
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [dismissed]);

  if (dismissed) return null;

  const opening = openingIndex >= 0;

  return (
    <div
      aria-hidden="true"
      onClick={dismiss}
      className="intro-overlay fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-black p-8"
    >
      <svg
        viewBox="0 0 64 40"
        shapeRendering="crispEdges"
        className="w-full max-w-xs fill-current text-white"
      >
        {opening ? (
          INTRO_OPENING_FRAMES.map((frame, i) => (
            <FrameLayer
              key={i}
              frame={frame}
              style={{ opacity: i === openingIndex ? 1 : 0 }}
            />
          ))
        ) : (
          <>
            <FrameLayer frame={INTRO_IDLE_FRAMES[0]} className="intro-idle-a" />
            <FrameLayer frame={INTRO_IDLE_FRAMES[1]} className="intro-idle-b" />
          </>
        )}
      </svg>
      <p className="max-w-xs text-center font-serif text-lg italic text-neutral-300">
        No one has read this page before you.
        <br />
        It did not exist until you arrived.
      </p>
    </div>
  );
}
