import Link from "next/link";

/**
 * Themed 404 — rendered wherever a route calls notFound() (an invalid
 * address, app/[[...address]]/page.tsx; the operator page for a non-operator,
 * app/operator/page.tsx) or a URL matches nothing at all. Before this file
 * existed, both cases fell through to Next's stock unstyled 404, jarring
 * against the rest of the site. Matches the placeholder styling in
 * app/[[...address]]/page-content.tsx (italic serif copy, a mono link
 * onward) without importing from there — that module's PAGE_HEIGHT sizing is
 * specific to a page-shaped container, which a 404 isn't.
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-2xl grow flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="font-serif text-lg italic text-neutral-400">
        There is no page at this address.
      </p>
      <Link
        href="/"
        className="font-mono text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        wander elsewhere →
      </Link>
    </main>
  );
}
