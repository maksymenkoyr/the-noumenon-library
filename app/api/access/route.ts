import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE_NAME, GATE_HTML, signSession } from "@/lib/access";
import { getClientIp } from "@/lib/clientIp";
import { config } from "@/lib/config";
import { query } from "@/lib/db";
import { ipHash } from "@/lib/ipHash";

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

  // Stored hashed, like every other IP touchpoint (lib/ipHash) — the raw
  // address is never persisted (docs/reference/legal.md). The hash still lets
  // the operator see whether two redemptions came from the same place.
  const ip = await getClientIp();
  const rows = await query<{ token: string; dev_mode: boolean; operator: boolean }>(
    `UPDATE access_tokens
        SET redeemed_at = now(), redeemed_ip = $2
      WHERE token = $1
      RETURNING token, dev_mode, operator`,
    [token, ip ? ipHash(ip) : null],
  );
  if (rows.length === 0) return denied(); // unknown token

  // Redemption history: one row per (token, place) in invite_redemptions —
  // repeat clicks from the same place bump `uses` instead of adding rows
  // (schema.sql). Single-statement upsert, so concurrent redemptions can't
  // lose a count.
  if (ip) {
    await query(
      `INSERT INTO invite_redemptions (token, ip_hash) VALUES ($1, $2)
       ON CONFLICT (token, ip_hash)
       DO UPDATE SET last_seen = now(), uses = invite_redemptions.uses + 1`,
      [token, ipHash(ip)],
    );
  }

  const response = NextResponse.redirect(new URL("/", request.url));
  // Bake the invite's dev / operator grants into the signed cookie, so both
  // checks stay a stateless read (lib/devMode, lib/operatorMode) — no
  // per-request DB lookup.
  response.cookies.set(
    COOKIE_NAME,
    await signSession(secret, { dev: rows[0].dev_mode, operator: rows[0].operator }),
    {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // one year
    },
  );
  return response;
}
