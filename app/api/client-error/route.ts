import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/clientIp";
import { admitEngagementWrite } from "@/lib/engagement";
import { monitor } from "@/lib/monitor";

/**
 * Client-side error report, added for public launch: React error boundaries
 * (app/error.tsx, app/global-error.tsx) are the only place a render/hydration
 * failure is ever seen, and until this route existed that failure was 100%
 * invisible server-side — nothing called monitor() for it. Fire-and-forget
 * from the boundary, same idiom as /api/engagement: the client never reads
 * the response, so this always 204s and swallows bad input rather than
 * surfacing a second error while reporting the first.
 *
 * Reuses the engagement throttle (lib/engagement.ts admitEngagementWrite) —
 * same per-IP ceiling as likes/dwell beacons — rather than minting a new
 * counter table for what should be a rare event; a client stuck in an error
 * loop is exactly the case this needs to cap.
 */
export const runtime = "nodejs";

const MAX_FIELD_CHARS = 2000;

function truncate(value: string): string {
  return value.length > MAX_FIELD_CHARS
    ? value.slice(0, MAX_FIELD_CHARS)
    : value;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const { message, stack, path, digest } = (body ?? {}) as {
    message?: unknown;
    stack?: unknown;
    path?: unknown;
    digest?: unknown;
  };
  if (typeof message !== "string" || typeof path !== "string") {
    return new NextResponse(null, { status: 204 });
  }

  if (await admitEngagementWrite(await getClientIp())) {
    await monitor("client_error", {
      message: truncate(message),
      path: truncate(path),
      ...(typeof stack === "string" ? { stack: truncate(stack) } : {}),
      ...(typeof digest === "string" ? { digest } : {}),
    });
  }
  return new NextResponse(null, { status: 204 });
}
