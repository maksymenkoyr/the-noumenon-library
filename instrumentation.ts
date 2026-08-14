import type { Instrumentation } from "next";
import * as Sentry from "@sentry/nextjs";

/**
 * Runs once per server instance before it serves requests. Sentry (§2.4)
 * needs its `init()` to happen before anything else, and its own config is
 * split by runtime — sentry.server.config.ts vs sentry.edge.config.ts — since
 * `NEXT_RUNTIME`-gated dynamic `import()` is how Next's build's dead-code
 * elimination keeps each runtime's bundle free of the other's dependencies
 * (see the `onRequestError` doc below for why that split matters here).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/**
 * Server errors that previously vanished: an uncaught throw during Server
 * Component render, a Route Handler, a Server Action, or proxy.ts (the
 * access gate) hit Next's default 500 and never reached monitor() — the
 * charter-critical alerting path (lib/monitor.ts). `onRequestError` is
 * Next's hook for exactly this (file-conventions/instrumentation.md).
 *
 * lib/monitor.ts (and the db.ts pool it writes through) depends on the `pg`
 * driver, which is Node-only — it cannot be bundled into the edge runtime
 * that proxy.ts and other edge-context errors run under. The dynamic
 * `import()` gated on `process.env.NEXT_RUNTIME` is the pattern Next's own
 * docs — and the Sentry Next.js SDK — use for exactly this split: the edge
 * build's dead-code elimination drops the untaken `nodejs` branch, so it
 * never tries to resolve `pg`'s node builtins. An edge-runtime error still
 * lands as a structured stderr line; it just skips monitor_events/Telegram.
 *
 * `Sentry.captureRequestError` is safe to call unconditionally in both
 * runtimes — unlike `pg`, `@sentry/nextjs` ships edge-conditioned exports
 * (its package.json `exports` map), so a top-level static import of it is
 * exactly what Sentry's own instrumentation.ts example does.
 *
 * Deliberately omits `request.headers` from the fields sent to monitor(): it
 * can carry the session cookie and other sensitive values, and nothing
 * downstream needs it. (Sentry's own capture uses the raw `request` object
 * too, but that path is scrubbed by sentry.*.config.ts's `beforeSend`.)
 */
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  Sentry.captureRequestError(error, request, context);

  const err = error as Error & { digest?: string };
  const fields = {
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    digest: err.digest,
    message: err.message,
  };

  if (process.env.NEXT_RUNTIME === "edge") {
    console.error(JSON.stringify({ type: "monitor", event: "request_error", ...fields }));
    return;
  }

  const { monitor } = await import("@/lib/monitor");
  await monitor("request_error", fields);
};
