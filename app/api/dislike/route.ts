import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getClientIp } from "@/lib/clientIp";
import {
  admitEngagementWrite,
  canonicalizeAddress,
  dislikeLeaf,
} from "@/lib/engagement";

/**
 * Mark / unmark a leaf "not for me" — the silent sibling of /api/like. Same
 * shape (per-reader state in localStorage, hashed-IP throttle, idempotency is
 * the client's job), with one deliberate difference: the aggregate count is
 * NEVER returned. The dislike is a research signal for the operator's insight
 * views, not a public score, so readers only ever learn `ok`.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { address, disliked } = (body ?? {}) as {
    address?: unknown;
    disliked?: unknown;
  };
  const canonical = canonicalizeAddress(address);
  if (!canonical || typeof disliked !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const clientIp = await getClientIp();
  if (!(await admitEngagementWrite(clientIp))) {
    return NextResponse.json({ ok: false });
  }

  await dislikeLeaf(canonical, disliked);
  return NextResponse.json({ ok: true });
}
