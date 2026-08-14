import * as Sentry from "@sentry/nextjs";
import { truncateLong } from "@/lib/sentryScrub";

/**
 * Edge-runtime Sentry init (§2.4, public beta launch) — proxy.ts (the access
 * gate) and any other edge-context error. Loaded from instrumentation.ts's
 * register() only under NEXT_RUNTIME === "edge". Same PII posture as
 * sentry.server.config.ts; kept as a separate file (rather than sharing one
 * init call) because that's the split Next/Sentry's own dual-runtime
 * instrumentation convention expects — see instrumentation.ts's doc.
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
