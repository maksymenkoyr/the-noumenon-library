"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatAddress, normalizeAddress } from "@/lib/address";

/**
 * The library's navigation: the only ways to move are wandering — random, the
 * next adjacent page, or a typed coordinate (docs/reference/experience.md "Navigation
 * model"). There is no search; you cannot look something up, only walk.
 *
 * `lib/address.ts` is a pure module (no node imports), so this client component
 * reuses the same `normalizeAddress` the server keys on to validate a typed
 * address inline before navigating — the server still normalizes as the source
 * of truth.
 *
 * `random` alone navigates with a full page load: `/` is a server redirect to a
 * fresh address (page.tsx), so it must re-resolve server-side on every click —
 * which client-side routing and Link prefetching would defeat. `next →` and the
 * typed `go to` have no such constraint; both resolve to a known address (a pure
 * `nextAddress`, or a `normalizeAddress` validated right here), so they navigate
 * client-side and the shell, fonts and layout stay mounted while only the page
 * body swaps. marks.tsx is written to survive that — see the breadcrumb claim
 * and the `leave` event there, both of which would otherwise assume one
 * document load per page.
 */
/**
 * Breadcrumb for the dwell beacon's `arrived_via` signal: written just before a
 * navigation, read-and-cleared by marks.tsx on the next page. sessionStorage is
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
  const router = useRouter();
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
    router.push(`/${formatAddress(address)}`);
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
      {/* prefetch={false} is load-bearing, not a micro-optimization: an
          uncrystallized address is GENERATED on request (lib/resolvePage.ts),
          so a speculative fetch would spend against the cap in lib/economics.ts
          on a page nobody read. Next already skips prefetching dynamic routes
          that have no loading.js — which is us — but that's a default, not a
          guarantee: adding an app/loading.tsx would silently turn this link
          into a generator. Pinned here so it can't.
          onNavigate rather than onClick: the breadcrumb must only be written
          when this tab actually navigates, or a Cmd+click (opens a new tab,
          this one stays put) would leave a stale one behind for the next real
          navigation to claim. */}
      <Link
        href={nextHref}
        prefetch={false}
        onNavigate={() => breadcrumb("next")}
        className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        next →
      </Link>
      {/* /liked is a listing, not a page: leaving the library's address space
          means no arrived_via breadcrumb is written. Prefetching is harmless
          here — unlike an address, this route generates nothing. */}
      <Link
        href="/liked"
        className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        liked
      </Link>
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
