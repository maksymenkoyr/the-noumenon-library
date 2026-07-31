import { NextResponse } from "next/server";
import { query } from "@/lib/db";

/**
 * Liveness probe for external uptime monitoring. Everything else on this deploy
 * answers 401 behind the invite gate (proxy.ts), so without this route an
 * outside checker cannot tell "running" from "broken" — a 401 is the *healthy*
 * response for every other path. This one is excluded from the gate matcher.
 *
 * The body is deliberately minimal: unauthenticated callers learn whether the
 * site is up and nothing about what is in it. In particular the DB error is
 * never echoed — it can carry connection-string fragments.
 *
 * The probe goes through lib/db's query() rather than opening its own
 * connection, so a failure here also fires the charter-critical
 * `db_query_failed` monitor event (§9) — one code path for detecting the
 * problem and alerting on it. monitor()'s throttle keeps a polling uptime cron
 * from turning that into a flood.
 */
export const runtime = "nodejs";

export async function GET() {
  // Route Handlers are uncached by default in Next 16; no-store additionally
  // stops any intermediary from serving a stale verdict.
  const headers = { "cache-control": "no-store" };
  try {
    await query("select 1");
    return NextResponse.json({ ok: true, db: "ok" }, { headers });
  } catch {
    return NextResponse.json(
      { ok: false, db: "error" },
      { status: 503, headers },
    );
  }
}
