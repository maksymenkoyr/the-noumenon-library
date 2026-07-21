"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { LIKE_EVENT, likedKey, migrateLegacyLikes } from "@/lib/liked";

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

// The nav breadcrumb for `arrived_via`, claimed (read-and-cleared) once per
// page load at module scope: page navigation is a full page load, so this runs
// exactly once per page, and an effect-scoped claim would be lost to
// StrictMode's dev double-mount. On the server (SSR import) sessionStorage
// throws → null. The claim then belongs to the FIRST page address mounted in
// this page load — a later page reached client-side (e.g. via /liked and back)
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
      .catch(() => {
        /* leave the optimistic count; the local mark still persists */
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
  // fresh in memory on mount — never written to a cookie or any Storage API,
  // so it dies with this page load and can't correlate across pages or visits.
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

    // Bind the page-load breadcrumb to the first page mounted; comparing by
    // address keeps it through StrictMode's dev remount of the same page.
    if (claimedForAddress === null) claimedForAddress = address;
    const arrivedVia = claimedForAddress === address ? claimedVia : null;

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
        scheduleIdleTimer();
      }
    };

    const onPageHide = () => {
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
    window.addEventListener("pagehide", onPageHide);
    for (const evt of activityEvents) {
      window.addEventListener(evt, onActivity, { passive: true });
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      for (const evt of activityEvents) {
        window.removeEventListener(evt, onActivity);
      }
      clearIdleTimer();
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
