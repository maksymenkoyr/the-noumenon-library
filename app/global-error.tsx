"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";
import "./globals.css";

/**
 * Root-layout error boundary: catches a throw from app/layout.tsx itself
 * (error.tsx can't — it renders *inside* the root layout, so it never sees a
 * failure in the layout that wraps it). Per the Next 16 file convention this
 * replaces the whole document, so it must declare its own <html>/<body> and
 * re-import globals.css — the one that ships via RootLayout is gone along
 * with the rest of the layout. No `metadata` export is allowed here; use
 * React's <title> instead (Next docs, file-conventions/error.md).
 *
 * Deliberately skips next/font (geistSans/geistMono/lora from
 * app/layout.tsx): this path exists for when the layout itself is broken,
 * so it stays on the smallest possible dependency surface and a system
 * serif/mono fallback rather than pulling in another thing that can fail.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "global-error");
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col items-center justify-center gap-4 bg-white p-8 text-center dark:bg-neutral-950">
        <title>The Noumenon Library</title>
        <p className="font-serif text-lg italic text-neutral-400">
          Something went wrong. The library is still there — try again.
        </p>
        {
          // A full reload, not <Link>: the whole document (including the
          // router) may be in a broken state at this point — see the module
          // doc above.
          // eslint-disable-next-line @next/next/no-html-link-for-pages
          <a
            href="/"
            className="font-mono text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            wander elsewhere →
          </a>
        }
      </body>
    </html>
  );
}
