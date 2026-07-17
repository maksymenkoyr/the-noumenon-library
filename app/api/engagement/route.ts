import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/clientIp";
import {
  admitEngagementWrite,
  canonicalizeAddress,
  recordDwell,
} from "@/lib/engagement";

/**
 * Dwell-time beacon (docs/reference/architecture.md §8, Phase 10). Sent via
 * navigator.sendBeacon on page-hide, so the body arrives as text/plain (a
 * Beacon Blob) rather than application/json — parse the raw text ourselves. Fire-
 * and-forget: the client never reads the response, so we always 204 and swallow
 * bad input rather than surfacing errors nobody sees.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const { address, dwellMs, arrivedVia } = (body ?? {}) as {
    address?: unknown;
    dwellMs?: unknown;
    arrivedVia?: unknown;
  };
  const canonical = canonicalizeAddress(address);
  if (!canonical || typeof dwellMs !== "number") {
    return new NextResponse(null, { status: 204 });
  }

  if (await admitEngagementWrite(await getClientIp())) {
    await recordDwell(
      canonical,
      dwellMs,
      typeof arrivedVia === "string" ? arrivedVia : undefined,
    );
  }
  return new NextResponse(null, { status: 204 });
}
