/**
 * Page rendering — the page as a fixed-size container holding a variable amount
 * of text (docs/reference/experience.md "The fixed-size page", architecture §6).
 *
 * Every state below shares the same `PAGE_HEIGHT` so the layout never shifts as
 * the Suspense fallback swaps for the finished page (the streaming guide's CLS
 * note). Text is top-aligned in a container sized to the page it was written
 * to fill.
 *
 * This used to read "a short page reads as a deliberate ending, not as
 * something broken — the quality bar is completeness, not fullness", and the
 * prompt was built to match: a per-page word budget from a wide range, and an
 * instruction to *end*. That produced pages that finished early and wrapped
 * themselves up, which is a short story, not a page of a book.
 *
 * The bar is now fullness, on 95% of pages. A page is cut off by the edge of
 * the paper (lib/pageCut.ts) rather than finished, so leftover whitespace
 * usually means a generation that came up short — `inputs.cut === false` marks
 * exactly those. The old case survives as the `complete` ending, held to 5%:
 * a real book does have short pages, and a wander of nothing but severed ones
 * has no rhythm.
 */

// Sized to hold config.pageWords at the reading font. The two are calibrated
// against each other and must move together — PAGE_WORDS is now enforced by an
// actual cut, so a mismatch shows up immediately as either a scrollbar or a
// band of dead white on every single page.
//
// 44rem over a 608px column of 18px Lora on 36px lines is ~19.5 lines, several
// of which go to blank lines between paragraphs. The previous comment claimed
// this "comfortably holds ~400 words"; it does not, and every page in the
// corpus overflowed it.
const PAGE_HEIGHT = "min-h-[44rem]";

/** A crystallized page: its text, top-aligned in the container. */
export function PageContent({ children }: { children: React.ReactNode }) {
  return (
    <article
      className={`${PAGE_HEIGHT} whitespace-pre-wrap font-serif text-lg leading-loose text-neutral-800 dark:text-neutral-200`}
    >
      {children}
    </article>
  );
}

/**
 * The Suspense fallback for a first visit: the page is crystallizing into being.
 * Same dimensions as a real page so nothing jumps when the page arrives.
 */
export function CrystallizingPage() {
  return (
    <div className={`flex ${PAGE_HEIGHT} items-center justify-center`}>
      <p className="animate-pulse font-serif text-lg italic text-neutral-400">
        crystallizing…
      </p>
    </div>
  );
}

const PLACEHOLDER_COPY = {
  taken_down: "This page has been removed from the library.",
  explore:
    "This corner of the library is still dark — wander elsewhere and return later.",
  rate_limited:
    "You're wandering faster than the library can crystallize new pages. Pause a moment, then return.",
} as const;

/**
 * A page with no readable content: taken down, explore-only, or rate-limited.
 * `explore` covers a generation/moderation failure or admission control
 * refusing generation past the global spend cap (§10) — not this visitor's
 * fault, so it offers the way onward. `rate_limited` is specifically this
 * visitor's own per-IP ceiling (lib/economics.ts); it deliberately has no
 * onward link — following it would just re-trigger the same limit — the ask
 * is to slow down, not to keep clicking.
 */
export function PlaceholderPage({
  variant,
}: {
  variant: keyof typeof PLACEHOLDER_COPY;
}) {
  return (
    <div
      className={`flex ${PAGE_HEIGHT} flex-col items-center justify-center gap-4 text-center`}
    >
      <p className="font-serif text-lg italic text-neutral-400">
        {PLACEHOLDER_COPY[variant]}
      </p>
      {variant === "explore" && (
        // Plain anchor: random must re-resolve server-side on every click.
        // eslint-disable-next-line @next/next/no-html-link-for-pages
        <a
          href="/"
          className="font-mono text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          wander elsewhere →
        </a>
      )}
    </div>
  );
}
