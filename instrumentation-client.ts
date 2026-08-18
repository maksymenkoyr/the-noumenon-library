import * as Sentry from "@sentry/nextjs";
import { truncateLong } from "@/lib/sentryScrub";

/**
 * Client-side Sentry init (§2.4, public beta launch) — the Next 16
 * instrumentation-client.ts convention (file-conventions/instrumentation-
 * client.md), executed once before hydration.
 *
 * NEXT_PUBLIC_SENTRY_DSN is the one deliberate exception to this app's "no
 * NEXT_PUBLIC_*" rule (lib/config.ts, .env.example): a DSN is a public
 * write-only key, and the browser SDK needs it directly — it can't go
 * through a server-only config getter. Unset => Sentry.init runs with an
 * empty dsn, a documented no-op.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  sendDefaultPii: false,
  beforeSend(event) {
    for (const exception of event.exception?.values ?? []) {
      if (exception.value) exception.value = truncateLong(exception.value);
    }
    if (event.message) event.message = truncateLong(event.message);
    if (event.request) {
      delete event.request.data;
      delete event.request.cookies;
    }
    return event;
  },
});

// Required by the SDK to instrument App Router navigations (build-time
// warning otherwise). Just timing/URL breadcrumbs — goes through the same
// beforeSend scrub above before anything is sent.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
