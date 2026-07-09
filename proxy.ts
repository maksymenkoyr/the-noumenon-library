import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { COOKIE_NAME, GATE_HTML, verifySession } from "@/lib/access";

/**
 * Private-access gate (Next 16 `proxy`, formerly `middleware`). Every request
 * except the redemption endpoint and static assets must carry a valid signed
 * session cookie (lib/access). Missing/invalid → the "this is private" page.
 *
 * When ACCESS_SIGNING_SECRET is unset (local dev, or an intentionally public
 * deploy) the gate is inert and the site is open. Redemption lives in
 * app/api/access — excluded from the matcher so an invite link can get in.
 */
export async function proxy(request: NextRequest) {
  const secret = appConfig.accessSigningSecret;
  if (!secret) return NextResponse.next(); // gate disabled

  const cookie = request.cookies.get(COOKIE_NAME)?.value;
  if (await verifySession(secret, cookie)) return NextResponse.next();

  return new NextResponse(GATE_HTML, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export const config = {
  // Gate everything except the redemption route and static assets.
  matcher: ["/((?!api/access|_next/static|_next/image|favicon.ico).*)"],
};
