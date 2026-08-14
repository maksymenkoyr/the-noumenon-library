"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";

/**
 * A visible beta notice (Phase 3, public beta launch): the library's premise
 * is that pages are stored forever, identical for every visitor — but this
 * deploy may still be reset while the app changes underneath it (see /about).
 * Dismissal persists per-browser in localStorage, same idiom as the page
 * marks (app/[[...address]]/marks.tsx) and the report control
 * (app/[[...address]]/report.tsx): a stable `false` server snapshot avoids a
 * hydration mismatch, and useSyncExternalStore re-renders on our own write
 * plus cross-tab `storage` events.
 */

const DISMISSED_KEY = "noumenon:beta-banner-dismissed";
const DISMISS_EVENT = "noumenon:beta-banner-dismissed-change";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null;
  } catch {
    return false; // localStorage disabled (private mode) — just show it every time
  }
}

function dismiss(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    /* non-fatal */
  }
  window.dispatchEvent(new Event(DISMISS_EVENT));
}

function useDismissed(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener(DISMISS_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        window.removeEventListener(DISMISS_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    readDismissed,
    () => false,
  );
}

export function BetaBanner() {
  const dismissed = useDismissed();
  if (dismissed) return null;

  return (
    <div className="flex items-center justify-center gap-4 bg-neutral-900 px-4 py-2 text-center font-mono text-xs text-neutral-200 dark:bg-neutral-100 dark:text-neutral-800">
      <p>
        Beta — the library is still settling, and may be reset.{" "}
        <Link
          href="/about"
          className="underline underline-offset-2 hover:text-white dark:hover:text-black"
        >
          read more
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="dismiss beta notice"
        className="shrink-0 hover:text-white dark:hover:text-black"
      >
        ×
      </button>
    </div>
  );
}
