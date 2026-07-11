"use client";

import { useState } from "react";
import { formatAddress, normalizeAddress } from "@/lib/address";

/**
 * The library's navigation: the only ways to move are wandering — random, the
 * next adjacent page, or a typed coordinate (docs/experience.md "Navigation
 * model"). There is no search; you cannot look something up, only walk.
 *
 * `lib/address.ts` is a pure module (no node imports), so this client component
 * reuses the same `normalizeAddress` the server keys on to validate a typed
 * address inline before navigating — the server still normalizes as the source
 * of truth. We navigate with a full page load (plain anchors / location.assign)
 * rather than the router: `random` must re-resolve server-side on every click,
 * which client-side routing and Link prefetching would defeat.
 */
/**
 * Breadcrumb for the dwell beacon's `arrived_via` signal: written just before a
 * navigation, read-and-cleared by marks.tsx on the next leaf. sessionStorage is
 * per-tab, so a fresh tab (direct URL, shared link) correctly reports nothing.
 */
const ARRIVED_KEY = "noumenon:arrived-via";

function breadcrumb(via: "random" | "next" | "typed"): void {
  try {
    sessionStorage.setItem(ARRIVED_KEY, via);
  } catch {
    /* best-effort research signal */
  }
}

export function Nav({ nextHref }: { nextHref: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  function go(event: React.FormEvent) {
    event.preventDefault();
    const segments = value.trim().replace(/^\/+|\/+$/g, "").split("/");
    const address = normalizeAddress(segments);
    if (!address) {
      setError(true);
      return;
    }
    breadcrumb("typed");
    window.location.assign(`/${formatAddress(address)}`);
  }

  return (
    <nav className="flex min-w-0 flex-1 items-center justify-end gap-4">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/"
        onClick={() => breadcrumb("random")}
        className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        random
      </a>
      <a
        href={nextHref}
        onClick={() => breadcrumb("next")}
        className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        next →
      </a>
      {/* No breadcrumb: /liked is a listing, not a leaf, and links from it
          arrive outside the wandering gestures (arrived_via stays NULL). */}
      <a
        href="/liked"
        className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        liked
      </a>
      <form onSubmit={go} className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="submit"
          className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          go to
        </button>
        <input
          aria-label="Go to address"
          placeholder="gallery/wall/shelf/volume/page"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(false);
          }}
          className={`min-w-0 flex-1 border-b bg-transparent pb-0.5 outline-none placeholder:text-neutral-400 focus:border-neutral-500 ${
            error ? "border-red-400" : "border-neutral-300 dark:border-neutral-700"
          }`}
        />
      </form>
    </nav>
  );
}
