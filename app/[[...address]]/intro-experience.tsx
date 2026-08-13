"use client";

import { useState } from "react";
import { Intro } from "./intro";

/**
 * Wraps `Intro` with a small "play intro again?" nudge, rendered right
 * after the overlay goes away for the first time. The overlay and "the
 * first generated page" are the same page load (Intro is mounted inside
 * the exact request that's crystallizing the address behind it,
 * app/[[...address]]/page.tsx) — there's no navigation between the two, so
 * this needs no cookie/sessionStorage signal of its own, just local state
 * for whether the overlay has gone away yet.
 *
 * `key={replayKey}` forces a full remount of `Intro` on replay — a clean
 * reset of its whole state machine (clock, phase, focus) rather than
 * threading a "play again" reset path through it.
 */
export function IntroExperience() {
  const [showHint, setShowHint] = useState(false);
  const [replayKey, setReplayKey] = useState(0);

  return (
    <>
      <Intro key={replayKey} force={replayKey > 0} onDone={() => setShowHint(true)} />
      {showHint && (
        <ReplayHint
          onReplay={() => {
            setShowHint(false);
            setReplayKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

function ReplayHint({ onReplay }: { onReplay: () => void }) {
  // `{showHint && <ReplayHint />}` in the parent means this element is
  // absent from the tree whenever showHint is false — so React mounts a
  // genuinely new node each time it flips back to true (after a replay
  // finishes), and the CSS entrance animation below replays for free with
  // it, no key/remount trick needed.
  return (
    <button
      type="button"
      onClick={onReplay}
      className="intro-replay-hint self-start rounded-sm font-mono text-sm text-neutral-500 outline-none hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[rgba(169,182,200,0.65)] dark:hover:text-neutral-100"
    >
      ↺ play intro again?
    </button>
  );
}
