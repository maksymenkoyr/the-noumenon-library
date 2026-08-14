"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  addressPath,
  formatAddress,
  normalizeAddress,
  randomAddress,
} from "@/lib/address";

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
 * All three wanders navigate client-side, so the shell, fonts and layout stay
 * mounted and only the page body swaps. Each resolves its destination here,
 * without a server round trip to decide where to go: `nextAddress` is pure,
 * a typed address is `normalizeAddress`-validated inline, and `randomAddress`
 * is nine lines of `Math.random()` — the same function `page.tsx` calls, in the
 * same pure module. marks.tsx is written to survive this — see the breadcrumb
 * claim and the `leave` event there, both of which would otherwise assume one
 * document load per page.
 *
 * The `/` route still resolves a fresh address server-side per request
 * (page.tsx, behind `await connection()`), and must: it is what a typed URL, a
 * shared link, a crawler and a JS-less browser get. Picking client-side changes
 * what this *link* does, not what that route does — which is why `random` keeps
 * a real `href="/"` underneath rather than becoming a button.
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

  /**
   * Roll the dice in the browser and go straight there, skipping the `/`
   * redirect hop entirely — same uniform distribution, one fewer round trip.
   *
   * Every early return below hands the click back to the anchor's `href="/"`,
   * which is the honest fallback: a modified click (new tab/window) and a
   * middle click both land on the server's own pick, and so does the whole
   * element if this script never runs. The breadcrumb is written only past
   * those returns, for the same reason `next →` uses `onNavigate` — a click
   * that opens a new tab leaves THIS one standing, and a breadcrumb written
   * for it would be claimed later by an unrelated navigation.
   */
  function wander(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return; // not a primary click
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    breadcrumb("random");
    router.push(addressPath(randomAddress()));
  }

  return (
    <nav className="flex min-w-0 flex-1 items-center justify-end gap-4">
      {/* A real anchor, not a Link: the client-side destination is rolled fresh
          per click (see `wander`), so there is no stable href for Link to hold —
          and `href="/"` is exactly the right thing to fall back to. The lint
          rule wants Link for internal routes; here the plain anchor IS the
          no-JS/new-tab path, so it stays. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/"
        onClick={wander}
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
      <form onSubmit={go} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <button
          type="submit"
          className="shrink-0 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          go to
        </button>
        <input
          aria-label="Go to address"
          aria-invalid={error}
          aria-describedby={error ? "address-error" : undefined}
          placeholder="gallery/wall/shelf/volume/page"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(false);
          }}
          className={`min-w-0 flex-1 border-b bg-transparent pb-0.5 placeholder:text-neutral-400 focus:border-neutral-500 ${
            error ? "border-red-400" : "border-neutral-300 dark:border-neutral-700"
          }`}
        />
        {error && (
          <p
            id="address-error"
            role="alert"
            className="basis-full font-mono text-xs text-red-600 dark:text-red-400"
          >
            not an address — try gallery/wall/shelf/volume/page
          </p>
        )}
      </form>
    </nav>
  );
}
