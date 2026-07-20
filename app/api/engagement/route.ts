import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/clientIp";
import { deviceClass } from "@/lib/device";
import {
  admitEngagementWrite,
  canonicalizeAddress,
  recordEvents,
  type RawEvent,
} from "@/lib/engagement";

/**
 * Reader-timeline beacon (docs/reference/architecture.md §8, Phase 10). Sent via
 * navigator.sendBeacon on visibility/page-hide transitions, so the body arrives
 * as text/plain (a Beacon Blob) rather than application/json — parse the raw
 * text ourselves. The payload is a per-page-load id (ephemeral, minted in the
 * browser, never persisted) plus a raw array of named, timestamped events —
 * idle detection and dwell math happen server-side (lib/engagement.ts), not in
 * the client. Fire-and-forget: the client never reads the response, so we
 * always 204 and swallow bad input rather than surfacing errors nobody sees.
 */
export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Validate the untrusted `events` payload shape; null if it doesn't fit. */
function parseEvents(raw: unknown): RawEvent[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const events: RawEvent[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { e, t, seq, via } = item as Record<string, unknown>;
    if (typeof e !== "string" || typeof t !== "number" || typeof seq !== "number") {
      return null;
    }
    events.push({
      e,
      t,
      seq,
      ...(typeof via === "string" ? { via } : {}),
    });
  }
  return events;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const { address, loadId, events } = (body ?? {}) as {
    address?: unknown;
    loadId?: unknown;
    events?: unknown;
  };
  const canonical = canonicalizeAddress(address);
  const validEvents = parseEvents(events);
  if (
    !canonical ||
    typeof loadId !== "string" ||
    !isUuid(loadId) ||
    !validEvents
  ) {
    return new NextResponse(null, { status: 204 });
  }

  if (await admitEngagementWrite(await getClientIp())) {
    const device = deviceClass(request.headers.get("user-agent"));
    await recordEvents(canonical, loadId, validEvents, device);
  }
  return new NextResponse(null, { status: 204 });
}
