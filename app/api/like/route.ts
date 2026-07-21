import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/clientIp";
import {
  admitEngagementWrite,
  canonicalizeAddress,
  getLikeCount,
  likePage,
} from "@/lib/engagement";

/**
 * Like / unlike a page (docs/reference/architecture.md §8, Phase 10). The app's per-
 * reader state lives in the browser (localStorage); this endpoint only keeps the
 * anonymous aggregate count. Idempotency is the client's job — it sends a like
 * only on an actual toggle — so a hashed-IP throttle is all the abuse guard the
 * counter needs. Returns the new count so the page can reconcile its display.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { address, pressed } = (body ?? {}) as {
    address?: unknown;
    pressed?: unknown;
  };
  const canonical = canonicalizeAddress(address);
  if (!canonical || typeof pressed !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const clientIp = await getClientIp();
  if (!(await admitEngagementWrite(clientIp))) {
    // Over the throttle: report the current count without mutating it, so a
    // hammering client neither inflates the counter nor sees an error.
    return NextResponse.json({ ok: false, count: await getLikeCount(canonical) });
  }

  const count = await likePage(canonical, pressed);
  return NextResponse.json({ ok: true, count });
}
