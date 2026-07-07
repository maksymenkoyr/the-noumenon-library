import { config } from "./config";

/**
 * Structured monitoring events. Unlike devLog (lib/log.ts), these are NOT gated
 * on dev mode — they fire in production. Each call emits one single-line JSON
 * object tagged `"type":"monitor"` so a log drain can filter on it and aggregate
 * by `event` / fields without parsing prose. Keep the payload small and the
 * shape stable: it's a query surface.
 *
 * On top of the log line, if `MONITOR_WEBHOOK_URL` is set the event is also
 * pushed to a Discord/Slack-compatible webhook for basic alerting
 * (docs/architecture.md §9, Phase 7). Events fired today:
 *   - `moderation_persistent_reject` (§7) — a page failed moderation twice.
 *   - `generation_failed` — a resolvePage generation attempt threw (provider
 *     error, persistent reject, or commit failure); the address stays dark.
 *   - `db_query_failed` — a Postgres query threw (the charter-critical signal:
 *     the precious store may be unreachable — see §9).
 *
 * Alerting is best-effort and must NEVER throw into or block the caller: a down
 * webhook can't be allowed to fail a request or mask the original error.
 */
export interface MonitorEvent {
  type: "monitor";
  event: string;
  ts: string;
  [field: string]: unknown;
}

export async function monitor(
  event: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  const payload: MonitorEvent = {
    type: "monitor",
    event,
    ts: new Date().toISOString(),
    ...fields,
  };
  // console.warn (stderr) keeps these off the normal output stream and visible
  // even when stdout is quieted; a drain matches on the JSON `type` field.
  console.warn(JSON.stringify(payload));
  await pushAlert(payload);
}

async function pushAlert(payload: MonitorEvent): Promise<void> {
  const url = config.monitorWebhookUrl;
  if (!url) return;
  // A readable one-liner, with `content`/`text` set so the same body works for
  // Discord (`content`) and Slack (`text`) without per-provider branching.
  const message = `⚠ ${payload.event} ${JSON.stringify(payload)}`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: message, text: message }),
    });
  } catch {
    // Alerting is best-effort — swallow so it never breaks the caller.
  }
}
