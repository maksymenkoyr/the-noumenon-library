import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME, GATE_HTML, signSession } from "@/lib/access";
import { getClientIp } from "@/lib/clientIp";
import { config } from "@/lib/config";
import { query } from "@/lib/db";

/**
 * Invite redemption (private-share deploy). A reusable link
 * `/api/access?invite=<token>` grants access on any device, any number of
 * times: the UPDATE succeeds for any known token, and redeemed_at/redeemed_ip
 * simply record the most recent use for the operator. On success we drop an
 * HMAC-signed session cookie (lib/access) so that browser wanders the library
 * freely, then redirect in.
 *
 * Excluded from the proxy matcher so it's reachable without a session.
 */
export const runtime = "nodejs";

function denied() {
  return new NextResponse(GATE_HTML, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function GET(request: NextRequest) {
  const secret = config.accessSigningSecret;
  // Gate disabled → nothing to redeem; just send them in.
  if (!secret) return NextResponse.redirect(new URL("/", request.url));

  const token = request.nextUrl.searchParams.get("invite");
  if (!token) return denied();

  const ip = await getClientIp();
  const rows = await query<{ token: string }>(
    `UPDATE access_tokens
        SET redeemed_at = now(), redeemed_ip = $2
      WHERE token = $1
      RETURNING token`,
    [token, ip ?? null],
  );
  if (rows.length === 0) return denied(); // unknown token

  const response = NextResponse.redirect(new URL("/", request.url));
  response.cookies.set(COOKIE_NAME, await signSession(secret), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // one year
  });
  return response;
}
