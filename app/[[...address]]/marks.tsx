"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { PRESS_EVENT, pressedKey } from "@/lib/pressed";

/**
 * Reader marks for a crystallized leaf (docs/reference/architecture.md §8, Phase 10):
 *
 *  - A "press" gesture — a page is a leaf; you press it the way you'd press a
 *    flower to keep it. Per-reader state lives in localStorage (no accounts); the
 *    aggregate count is a small server counter, shown here on the leaf. The heart
 *    is deliberately muted ink, not social-app red, to sit in the quiet palette.
 *  - A dwell timer — accumulates visible time on the leaf and beacons it once on
 *    page-hide, feeding the engagement research signal. Fire-and-forget.
 *
 * The app's second client component (after nav.tsx). Rendered only under a
 * committed (`ok`) leaf, so its address always has a row in `pages`.
 */

const dislikedKey = (address: string) => `noumenon:disliked:${address}`;

// The nav breadcrumb for `arrived_via`, claimed (read-and-cleared) once per
// page load at module scope: leaf navigation is a full page load, so this runs
// exactly once per leaf, and an effect-scoped claim would be lost to
// StrictMode's dev double-mount. On the server (SSR import) sessionStorage
// throws → null. The claim then belongs to the FIRST leaf address mounted in
// this page load — a later leaf reached client-side (e.g. via /liked and back)
// must not inherit it.
const claimedVia: string | null = (() => {
  try {
    const via = sessionStorage.getItem("noumenon:arrived-via");
    sessionStorage.removeItem("noumenon:arrived-via");
    return via;
  } catch {
    return null; // best-effort research signal
  }
})();
let claimedForAddress: string | null = null;

function readMark(key: string): boolean {
  try {
    // Any non-null value is a mark — old press marks stored "1", newer ones a
    // timestamp (lib/pressed.ts).
    return localStorage.getItem(key) !== null;
  } catch {
    return false; // localStorage disabled (private mode) — just never persists
  }
}

function writeMark(key: string, on: boolean): void {
  try {
    // The value is the mark time, so /liked can order presses by recency.
    if (on) localStorage.setItem(key, String(Date.now()));
    else localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  window.dispatchEvent(new Event(PRESS_EVENT));
}

/**
 * The browser's own mark (press or "not for me"), read through
 * useSyncExternalStore so the server snapshot is a stable `false` (no hydration
 * mismatch) and the read isn't a setState-in-effect. Re-renders on our own
 * writes and on cross-tab `storage`.
 */
function useLocalMark(key: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(PRESS_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(PRESS_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => readMark(key),
    () => false,
  );
}

function readers(count: number): string {
  return `${count} ${count === 1 ? "reader" : "readers"}`;
}

export function Marks({
  address,
  initialCount,
}: {
  address: string;
  initialCount: number;
}) {
  const pressed = useLocalMark(pressedKey(address));
  const disliked = useLocalMark(dislikedKey(address));
  const [count, setCount] = useState(initialCount);

  const toggle = useCallback(() => {
    const next = !pressed;
    writeMark(pressedKey(address), next); // flips `pressed` via the external store
    setCount((c) => Math.max(c + (next ? 1 : -1), 0)); // optimistic
    fetch("/api/like", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, pressed: next }),
      keepalive: true,
    })
      .then((r) => r.json())
      .then((data) => {
        if (typeof data?.count === "number") setCount(data.count); // reconcile
      })
      .catch(() => {
        /* leave the optimistic count; the local mark still persists */
      });
  }, [pressed, address]);

  // The silent "not for me" mark: local toggle + fire-and-forget aggregate
  // write. Deliberately no count anywhere — a research signal, not a score.
  const toggleDislike = useCallback(() => {
    const next = !disliked;
    writeMark(dislikedKey(address), next);
    fetch("/api/dislike", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, disliked: next }),
      keepalive: true,
    }).catch(() => {
      /* the local mark still persists */
    });
  }, [disliked, address]);

  // Dwell timer: accumulate visible time, beacon it once when the reader leaves.
  useEffect(() => {
    let accumulated = 0;
    let visibleSince = document.hidden ? null : performance.now();
    let sent = false;

    // Bind the page-load breadcrumb to the first leaf mounted; comparing by
    // address keeps it through StrictMode's dev remount of the same leaf.
    if (claimedForAddress === null) claimedForAddress = address;
    const arrivedVia = claimedForAddress === address ? claimedVia : null;

    const flush = () => {
      if (visibleSince !== null) {
        accumulated += performance.now() - visibleSince;
        visibleSince = null;
      }
      if (sent || accumulated < 1000) return; // ignore sub-second glances
      sent = true;
      try {
        navigator.sendBeacon(
          "/api/engagement",
          JSON.stringify({
            address,
            dwellMs: Math.round(accumulated),
            ...(arrivedVia ? { arrivedVia } : {}),
          }),
        );
      } catch {
        /* best-effort research signal */
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        flush();
      } else if (!sent) {
        visibleSince = performance.now();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [address]);

  const label = pressed
    ? `pressed · ${readers(count)}`
    : count > 0
      ? readers(count)
      : "press this leaf";

  return (
    <div className="flex items-baseline gap-6 font-mono text-sm text-neutral-500">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={pressed}
        aria-label={pressed ? "un-press this leaf" : "press this leaf"}
        className="inline-flex items-center gap-2 hover:text-neutral-800 dark:hover:text-neutral-200"
      >
        <span
          aria-hidden
          className={
            pressed ? "text-neutral-800 dark:text-neutral-200" : undefined
          }
        >
          {pressed ? "♥" : "♡"}
        </span>
        <span>{label}</span>
      </button>
      <button
        type="button"
        onClick={toggleDislike}
        aria-pressed={disliked}
        aria-label={disliked ? "unmark not for me" : "mark not for me"}
        className={`hover:text-neutral-800 dark:hover:text-neutral-200 ${
          disliked ? "text-neutral-800 dark:text-neutral-200" : ""
        }`}
      >
        not for me
      </button>
    </div>
  );
}
