"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { LIKE_EVENT, likedKey, migrateLegacyLikes } from "@/lib/liked";
import { reportClientError } from "@/lib/reportClientError";

migrateLegacyLikes();

/**
 * Reader marks for a crystallized page (docs/reference/architecture.md §8, Phase 10):
 *
 *  - A "like" gesture — a small keepsake, not a social vote. Per-reader state
 *    lives in localStorage (no accounts); the aggregate count is a small server
 *    counter, shown here on the page. The heart is deliberately muted ink, not
 *    social-app red, to sit in the quiet palette.
 *  - A reader timeline — emits named, timestamped events (arrive, visible,
 *    hidden, idle, active, leave) as the reader interacts with the page, and
 *    beacons them as a raw event log rather than one computed total. Idle
 *    detection and dwell math happen server-side (lib/engagement.ts) so that
 *    policy (e.g. the idle threshold) isn't baked into this client forever.
 *    Fire-and-forget.
 *
 * The app's second client component (after nav.tsx). Rendered only under a
 * committed (`ok`) page, so its address always has a row in `pages`.
 */

const dislikedKey = (address: string) => `noumenon:disliked:${address}`;

const ARRIVED_KEY = "noumenon:arrived-via";

/**
 * The most recent breadcrumb claim, so a remount of the SAME address reuses it
 * rather than re-reading an already-cleared key. This memo is what lets the
 * claim live per-navigation instead of per-document: `next →` and the typed
 * `go to` are client-side navigations (nav.tsx), so this module is evaluated
 * once per document but must yield a fresh breadcrumb on every page.
 *
 * One slot, not a Map, and deliberately so: wandering A → B → A must re-read
 * for the second A (the intervening B claim displaces it), while StrictMode's
 * dev double-mount of a single address — which remounts immediately, with no
 * intervening claim — reuses it. It also can't grow across a long session.
 */
let lastClaim: { address: string; via: string | null } | null = null;

/**
 * Read-and-clear the nav breadcrumb for this navigation, so each one is
 * consumed exactly once. On the server (SSR import) sessionStorage throws →
 * null, and a fresh tab (direct URL, shared link) finds no key → null, so both
 * correctly report nothing. A page reached without a breadcrumb write (e.g.
 * back from /liked) likewise inherits nothing, since the key was already
 * cleared by whoever claimed it.
 */
function claimArrivedVia(address: string): string | null {
  if (lastClaim?.address === address) return lastClaim.via;
  let via: string | null = null;
  try {
    via = sessionStorage.getItem(ARRIVED_KEY);
    sessionStorage.removeItem(ARRIVED_KEY);
  } catch {
    /* best-effort research signal */
  }
  lastClaim = { address, via };
  return via;
}

function readMark(key: string): boolean {
  try {
    // Any non-null value is a mark — old like marks stored "1", newer ones a
    // timestamp (lib/liked.ts).
    return localStorage.getItem(key) !== null;
  } catch {
    return false; // localStorage disabled (private mode) — just never persists
  }
}

function writeMark(key: string, on: boolean): void {
  try {
    // The value is the mark time, so /liked can order likes by recency.
    if (on) localStorage.setItem(key, String(Date.now()));
    else localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
  window.dispatchEvent(new Event(LIKE_EVENT));
}

/**
 * The browser's own mark (like or "not for me"), read through
 * useSyncExternalStore so the server snapshot is a stable `false` (no hydration
 * mismatch) and the read isn't a setState-in-effect. Re-renders on our own
 * writes and on cross-tab `storage`.
 */
function useLocalMark(key: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(LIKE_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(LIKE_EVENT, onChange);
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
  const liked = useLocalMark(likedKey(address));
  const disliked = useLocalMark(dislikedKey(address));
  const [count, setCount] = useState(initialCount);

  const toggle = useCallback(() => {
    const next = !liked;
    writeMark(likedKey(address), next); // flips `liked` via the external store
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
      .catch((err) => {
        // The write may not have landed server-side — leaving the optimistic
        // count in place would show a like that never actually registered in
        // the aggregate. Revert it; the local mark (writeMark, above) stays,
        // since that's the reader's own gesture, not the server sync.
        setCount((c) => Math.max(c + (next ? -1 : 1), 0));
        reportClientError(
          err instanceof Error ? err : new Error("like request failed"),
          `/api/like?address=${address}`,
        );
      });
  }, [liked, address]);

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

  // Reader timeline: record named, timestamped events and beacon the raw log
  // (not a computed total) so idle detection / dwell math can live server-side
  // (lib/engagement.ts recordEvents). The only identifier is `loadId`, minted
  // fresh in memory here — never written to a cookie or any Storage API. Keyed
  // on `address`, so it is re-minted per page even when the surrounding
  // document survives a client-side wander (nav.tsx): one page, one id, and
  // no correlation across pages or visits.
  useEffect(() => {
    const IDLE_MS = 60_000; // no activity for this long while visible -> idle
    const ACTIVITY_THROTTLE_MS = 1000; // ignore activity bursts (pointermove...)

    const loadId = crypto.randomUUID();
    let seq = 0;
    const buffer: { e: string; t: number; seq: number; via?: string }[] = [];
    let sentCount = 0; // how many buffer entries have already been beaconed
    let idle = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastActivityAt = 0;
    let left = false; // this load's closing event has been emitted (see `leave`)

    const arrivedVia = claimArrivedVia(address);

    const emit = (name: string, via?: string) => {
      const t = Math.round(performance.now());
      buffer.push(via ? { e: name, t, seq: seq++, via } : { e: name, t, seq: seq++ });
    };

    const flush = () => {
      if (buffer.length <= sentCount) return;
      const events = buffer.slice(sentCount);
      try {
        navigator.sendBeacon(
          "/api/engagement",
          JSON.stringify({ loadId, address, events }),
        );
      } catch {
        /* best-effort research signal */
      }
      sentCount = buffer.length; // don't retry — the server dedupes anyway
    };

    const clearIdleTimer = () => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    // Only armed while visible — nothing schedules/reschedules it while hidden.
    const scheduleIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idle = true;
        emit("idle");
      }, IDLE_MS);
    };

    const onActivity = () => {
      if (document.hidden) return; // idle timer isn't running while hidden
      const now = performance.now();
      if (now - lastActivityAt < ACTIVITY_THROTTLE_MS) return; // throttle bursts
      lastActivityAt = now;
      if (idle) {
        idle = false;
        emit("active");
      }
      scheduleIdleTimer();
    };

    const onVisibility = () => {
      if (document.hidden) {
        emit("hidden");
        clearIdleTimer();
        flush();
      } else {
        emit("visible");
        idle = false;
        left = false; // restored from bfcache: we're reading again, so a later
        // departure is a real second `leave`, not a duplicate.
        scheduleIdleTimer();
      }
    };

    /**
     * The load's closing event. Reached two mutually exclusive ways: `pagehide`
     * for a real departure (tab close, full page load — React cleanup does not
     * run), and the effect cleanup for a client-side navigation (`pagehide`
     * does not fire). The `left` guard makes it exactly once per departure
     * whichever path gets there.
     */
    const leave = () => {
      if (left) return;
      left = true;
      emit("leave");
      flush();
    };

    // The load's opening event, plus an immediate "visible" if it starts
    // foregrounded (mirrors what onVisibility emits on a later hidden->visible
    // transition, so the server's dwell math has one uniform starting signal).
    emit("arrive", arrivedVia ?? undefined);
    if (!document.hidden) {
      emit("visible");
      scheduleIdleTimer();
    }

    const activityEvents = [
      "pointermove",
      "keydown",
      "scroll",
      "click",
      "touchstart",
    ] as const;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    for (const evt of activityEvents) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
      for (const evt of activityEvents) {
        window.removeEventListener(evt, onActivity);
      }
      clearIdleTimer();
      leave(); // client-side navigation away: `pagehide` never fires
    };
  }, [address]);

  const label = liked
    ? `liked · ${readers(count)}`
    : count > 0
      ? readers(count)
      : "like this page";

  return (
    <div className="flex items-baseline gap-6 font-mono text-sm text-neutral-500">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={liked}
        aria-label={liked ? "unlike this page" : "like this page"}
        className="inline-flex items-center gap-2 hover:text-neutral-800 dark:hover:text-neutral-200"
      >
        <span
          aria-hidden
          className={
            liked ? "text-neutral-800 dark:text-neutral-200" : undefined
          }
        >
          {liked ? "♥" : "♡"}
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
