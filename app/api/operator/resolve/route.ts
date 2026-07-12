import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, readSessionClaims } from "@/lib/access";
import { config } from "@/lib/config";
import { resolveReport } from "@/lib/reports";

/**
 * Acknowledge one open report (app/operator). Re-verifies the operator claim
 * server-side from the session cookie (never trust the client that rendered
 * the page) and 404s on failure — same non-disclosure as the page itself
 * (lib/operatorMode): a non-operator, or the gate being inert, must see no
 * evidence this route exists.
 */
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const secret = config.accessSigningSecret;
  if (!secret) return new NextResponse(null, { status: 404 });

  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  const claims = await readSessionClaims(secret, cookie);
  if (claims?.operator !== true) return new NextResponse(null, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { id } = (body ?? {}) as { id?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const ok = await resolveReport(id);
  return NextResponse.json({ ok });
}
