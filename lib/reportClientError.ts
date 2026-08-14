/**
 * Fire-and-forget POST to /api/client-error from a React error boundary
 * (app/error.tsx, app/global-error.tsx). Both boundaries are 'use client', so
 * this stays a plain browser-safe function — no server-only imports. Never
 * throws: reporting a render error must not itself become an unhandled
 * rejection in an already-broken tree.
 */
export function reportClientError(
  error: Error & { digest?: string },
  path: string,
): void {
  try {
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        path,
        digest: error.digest,
      }),
      keepalive: true,
    }).catch(() => {
      /* best-effort; nothing else to fall back to from a crashed tree */
    });
  } catch {
    /* ditto, for the synchronous path (e.g. fetch unavailable) */
  }
}
