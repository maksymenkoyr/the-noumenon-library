/**
 * Structured monitoring events. Unlike devLog
 * (lib/log.ts), these are NOT gated on dev mode — they fire in production. Each
 * call emits one single-line JSON object tagged `"type":"monitor"` so a log
 * drain can filter on it and aggregate by `event` / fields without parsing
 * prose. Keep the payload small and the shape stable: it's a query surface.
 *
 * Today the only event is `moderation_persistent_reject` (docs/architecture.md
 * §7): a page that failed moderation twice in one generation. We expect this to
 * be vanishingly rare; if an address fires it repeatedly, a human investigates
 * and acts (e.g. takedown). Nothing is stored or permanently blocked
 * automatically — see lib/pipeline.ts.
 */
export interface MonitorEvent {
  type: "monitor";
  event: string;
  ts: string;
  [field: string]: unknown;
}

export function monitor(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const payload: MonitorEvent = {
    type: "monitor",
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  // console.warn (stderr) keeps these off the normal output stream and visible
  // even when stdout is quieted; a drain matches on the JSON `type` field.
  console.warn(JSON.stringify(payload));
}
