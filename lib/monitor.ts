import { Pool } from "pg";
import { config } from "./config";

/**
 * Structured monitoring events. Unlike devLog (lib/log.ts), these are NOT gated
 * on dev mode — they fire in production. Each call emits one single-line JSON
 * object tagged `"type":"monitor"` so a log drain can filter on it and aggregate
 * by `event` / fields without parsing prose. Keep the payload small and the
 * shape stable: it's a query surface.
 *
 * On top of the log line, if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are
 * both set the event is also pushed to Telegram (docs/reference/architecture.md
 * §9, Phase 7), and — except for `db_query_failed` — the event is written to
 * the `monitor_events` table (lib/schema.sql) so it outlives both Vercel
 * Hobby's 1-hour log retention and Telegram's lack of a history/search view.
 * Events fired today:
 *   - `db_query_failed` (lib/db.ts) — a Postgres query threw. The
 *     charter-critical signal: the precious store may be unreachable (§9).
 *     Carries `op`, the `"<module>.<function>"` label of the calling site.
 *     Every query in the app funnels through the one wrapper, so without it a
 *     safely-ignorable telemetry write (`modelStats.recordModelCall`) reads
 *     identically to a lost page commit (`store.commitPage`).
 *   - `generation_failed` (lib/resolvePage.ts) — a resolvePage attempt threw
 *     (provider error, persistent reject, or commit failure); address stays dark.
 *   - `commit_lost` (lib/resolvePage.ts) — a generated page failed to persist.
 *   - `moderation_persistent_reject` (lib/pipeline.ts, §7) — a page failed
 *     moderation twice.
 *   - `moderation_disabled_in_production` (lib/moderate.ts) — the fail-closed
 *     guard found moderation off in a production deploy.
 *   - `model_unavailable` (lib/registry.ts) — a registered model can't be used.
 *   - `gallery_seed_failed` (lib/gallerySeeds.ts) — a gallery's association
 *     expansion failed. Not page-fatal: generation carries on unseeded and the
 *     next visit to that gallery retries.
 *   - `page_reported` (app/api/report/route.ts) — a reader filed a report.
 *   - `report_email_failed` (lib/reportEmail.ts) — the report notification
 *     couldn't be delivered.
 *   - `spend_cap_reached` (lib/economics.ts) — the monthly spend cap has been
 *     hit; generation is capped to explore-only for the rest of the month.
 *   - `spend_threshold_reached` (lib/economics.ts) — this month's spend
 *     crossed 50/80/100% of the cap for the first time (monthly_spend.alerted_pct).
 *   - `rate_limit_tripped` (lib/economics.ts) — a visitor's per-minute or
 *     per-hour generation ceiling was hit.
 *   - `request_error` (instrumentation.ts) — an uncaught server error (render,
 *     route handler, action, or the proxy.ts access gate).
 *   - `client_error` (app/api/client-error/route.ts) — a browser-side render
 *     error reported by app/error.tsx or app/global-error.tsx.
 *
 * Alerting is best-effort and must NEVER throw into or block the caller: a down
 * Telegram can't be allowed to fail a request or mask the original error.
 */
export interface MonitorEvent {
  type: "monitor";
  event: string;
  ts: string;
  [field: string]: unknown;
}

/**
 * Telegram rejects a sendMessage body over 4096 characters outright, and a
 * `db_query_failed` payload carries a driver error message of unbounded length.
 * Truncate rather than let the whole alert 400 away.
 */
const TELEGRAM_MAX_CHARS = 4096;

/** Minimum gap between two pushes of the same event name. */
const ALERT_THROTTLE_MS = 60_000;

/**
 * Per-event send times, so one failure mode can't flood the chat. A DB outage
 * fires `db_query_failed` on *every* request; unthrottled that trips Telegram's
 * ~20-messages-per-minute chat limit into a flood-wait, and the alert that
 * matters gets dropped along with the noise.
 *
 * Caveat worth knowing: this Map lives in one serverless instance's memory, so
 * N warm instances can each send once per window. It collapses the dominant
 * case — a single hot instance retrying — but it is not a global lock.
 */
const alertThrottle = new Map<string, { at: number; suppressed: number }>();

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
  // Every event is logged, including ones the throttle keeps out of Telegram.
  console.warn(JSON.stringify(payload));
  await Promise.all([pushAlert(payload), writeEvent(event, fields)]);
}

/**
 * Own tiny pool, deliberately separate from lib/db.ts's — importing `query`
 * from there would mean this module and lib/db.ts import each other (`query`
 * calls `monitor` on failure), and more importantly a failed write here must
 * never itself go through the path that calls `monitor("db_query_failed")`,
 * which is exactly the recursion the `db_query_failed` skip below guards
 * against. `max: 1`: this pool only ever does small, infrequent inserts.
 */
declare global {
  var __noumenonMonitorPool: Pool | undefined;
}

function getMonitorPool(): Pool {
  if (!globalThis.__noumenonMonitorPool) {
    const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
    pool.on("error", () => {
      // Same rationale as lib/db.ts's idle-client handler: log only, never
      // throw into whatever request happens to be running when Neon drops an
      // idle connection.
    });
    globalThis.__noumenonMonitorPool = pool;
  }
  return globalThis.__noumenonMonitorPool;
}

/**
 * Persist one event to `monitor_events`. Best-effort in every sense: never
 * throws, never retries, and — critically — never calls `monitor()` on
 * failure (that would be the recursion this whole function exists to avoid).
 * `db_query_failed` itself is skipped outright: it already fires on every
 * request during a DB outage, and writing it TO the DB during a DB outage is
 * the one case guaranteed to fail.
 */
async function writeEvent(
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  if (event === "db_query_failed") return;
  try {
    await getMonitorPool().query(
      `INSERT INTO monitor_events (event, fields, deployment) VALUES ($1, $2, $3)`,
      [event, JSON.stringify(fields), process.env.VERCEL_DEPLOYMENT_ID ?? null],
    );
  } catch {
    // Best-effort, per the module doc above.
  }
}

/** Close the durability pool (tests only; never called per-request). */
export async function closeMonitorPool(): Promise<void> {
  if (globalThis.__noumenonMonitorPool) {
    await globalThis.__noumenonMonitorPool.end();
    globalThis.__noumenonMonitorPool = undefined;
  }
}

/**
 * Decide whether this event may be pushed now. When it may, report how many
 * pushes were suppressed since the last one that got through, so the message
 * can say what it stands for rather than silently representing one of many.
 */
function claimAlertSlot(event: string): { send: boolean; suppressed: number } {
  const now = Date.now();
  const previous = alertThrottle.get(event);
  if (previous && now - previous.at < ALERT_THROTTLE_MS) {
    previous.suppressed += 1;
    return { send: false, suppressed: previous.suppressed };
  }
  alertThrottle.set(event, { at: now, suppressed: 0 });
  return { send: true, suppressed: previous?.suppressed ?? 0 };
}

async function pushAlert(payload: MonitorEvent): Promise<void> {
  const token = config.telegramBotToken;
  const chatId = config.telegramChatId;
  // Either unset (local dev, or a deploy that hasn't wired alerting) => the
  // structured log line is the whole story, exactly as before.
  if (!token || !chatId) return;

  const { send, suppressed } = claimAlertSlot(payload.event);
  if (!send) return;

  // Event name first so the chat stays skimmable on a phone, then the full
  // payload for detail.
  const tail = suppressed > 0 ? ` (+${suppressed} suppressed)` : "";
  const text = `⚠ ${payload.event}${tail} ${JSON.stringify(payload)}`.slice(
    0,
    TELEGRAM_MAX_CHARS,
  );
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Alerting is best-effort — swallow so it never breaks the caller.
  }
}
