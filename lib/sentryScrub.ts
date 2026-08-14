/**
 * Shared page-text guard for Sentry (§2.4, public beta launch), used by the
 * `beforeSend` in sentry.server.config.ts, sentry.edge.config.ts, and
 * instrumentation-client.ts. Generated pages are the artwork and user-facing
 * content — never something to mirror into a third party.
 *
 * A legitimate error message is a sentence or two; a crystallized page is
 * hundreds of words (config.pageWords). Truncating any string that long,
 * wherever it turns up in an event, is a blunt but reliable way to keep page
 * text out without having to enumerate every field an error could carry it
 * in — deliberately simpler than trying to detect "is this page content"
 * semantically.
 */
const MAX_CHARS = 300;

export function truncateLong(value: string): string {
  return value.length > MAX_CHARS ? `${value.slice(0, MAX_CHARS)}… [truncated]` : value;
}
