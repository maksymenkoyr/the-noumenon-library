"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { reportClientError } from "@/lib/reportClientError";

/**
 * Route-segment error boundary: catches a render throw anywhere under the
 * root layout (app/layout.tsx stays intact, unlike global-error.tsx) and
 * shows a themed fallback instead of Next's stock error screen. Styled to
 * match the placeholder states in app/[[...address]]/page-content.tsx
 * (PlaceholderPage) — same italic-serif copy, mono link — so a crash still
 * reads as this site, not a broken one.
 *
 * Must be a Client Component (error boundaries always are). Reports to
 * /api/client-error on mount so a render failure is no longer invisible
 * server-side (§2.3) — before this, the only signal was whatever the
 * visitor happened to say in a bug report.
 */
export default function Error({
  error,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const pathname = usePathname();

  useEffect(() => {
    reportClientError(error, pathname);
  }, [error, pathname]);

  return (
    <main className="mx-auto flex w-full max-w-2xl grow flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="font-serif text-lg italic text-neutral-400">
        Something went wrong turning this page.
      </p>
      {
        // A full reload, not client-side nav: whatever threw may have left
        // router/app state in a bad way, so a fresh document load is the
        // safer recovery. Same choice as the `explore` placeholder variant
        // (page-content.tsx).
        // eslint-disable-next-line @next/next/no-html-link-for-pages
        <a
          href="/"
          className="font-mono text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          wander elsewhere →
        </a>
      }
    </main>
  );
}
