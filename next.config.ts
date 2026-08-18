import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  /* config options here */
};

// Sentry (§2.4, public beta launch, free tier): wraps the build to upload
// source maps and add a little extra instrumentation. Fully optional at
// build time — SENTRY_ORG/SENTRY_PROJECT/SENTRY_AUTH_TOKEN are all unset by
// default, and the plugin just skips the (auth-required) source-map upload
// with a warning rather than failing the build; `silent: true` keeps that
// warning out of normal build output. NEXT_PUBLIC_SENTRY_DSN being unset
// (also the default) separately makes the SDK itself a no-op at runtime —
// see sentry.server.config.ts.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
});
