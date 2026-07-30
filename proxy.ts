import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { COOKIE_NAME, GATE_HTML, isGateActive, verifySession } from "@/lib/access";

/**
 * Private-access gate (Next 16 `proxy`, formerly `middleware`). Every request
 * except the redemption endpoint, robots.txt, and static assets must carry a
 * valid signed session cookie (lib/access). Missing/invalid → the "this is
 * private" page.
 *
 * The gate goes inert two ways (lib/access.ts isGateActive): no
 * ACCESS_SIGNING_SECRET at all (local dev), or a secret present but
 * ACCESS_GATE_ENABLED=false (the intentional public deploy — the secret stays
 * set so operator/dev-overlay claims in existing invite cookies still work;
 * only the traffic block lifts). Redemption lives in app/api/access —
 * excluded from the matcher so an invite link can get in.
 */
export async function proxy(request: NextRequest) {
  const secret = appConfig.accessSigningSecret;
  if (!isGateActive(secret, appConfig.accessGateEnabled)) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (await verifySession(secret, cookie)) return NextResponse.next();

  return new NextResponse(GATE_HTML, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export const config = {
  // Gate everything except the redemption route, robots.txt, and static
  // assets — robots.txt must stay readable even while a deploy is gated.
  matcher: [
    "/((?!api/access|robots\\.txt|_next/static|_next/image|favicon\\.ico).*)",
  ],
};
