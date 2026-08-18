import * as Sentry from "@sentry/nextjs";
import { truncateLong } from "@/lib/sentryScrub";

/**
 * Node-runtime Sentry init (§2.4, public beta launch). Loaded from
 * instrumentation.ts's register() only under NEXT_RUNTIME === "nodejs" —
 * Sentry's own documented split for dual-runtime instrumentation.
 *
 * NEXT_PUBLIC_SENTRY_DSN unset (the default; see .env.example) => Sentry.init
 * runs with an empty dsn, a documented no-op — nothing is captured or sent.
 * Free tier, no Sentry account required to ship this.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0,
  // Never send page text (generated pages are the artwork, user-facing
  // content) or anything beyond what an error's own short message carries.
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
