/**
 * Page rendering — the page as a fixed-size container holding a variable amount
 * of text (docs/reference/experience.md "The fixed-size page", architecture §6).
 *
 * Every state below shares the same `PAGE_HEIGHT` so the layout never shifts as
 * the Suspense fallback swaps for the finished page (the streaming guide's CLS
 * note). Text is top-aligned with honest whitespace beneath: a short page reads
 * as a deliberate ending, not as something broken. The quality bar is
 * completeness, not fullness.
 */

// Calibrated to comfortably hold ~PAGE_MAX_WORDS (400) at the reading font;
// a full page fills the container, a fragment leaves honest white below.
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
} as const;

/**
 * A page with no readable content: either taken down, or explore-only (the page
 * could not be crystallized right now — a generation/moderation failure, or
 * admission control refusing generation past the spend cap / rate limit (§10).
 * The explore variant offers the way onward.
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
