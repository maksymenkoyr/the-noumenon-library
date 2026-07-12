import { cookies } from "next/headers";
import { COOKIE_NAME, readSessionClaims } from "./access";
import { config } from "./config";

/**
 * Whether the current request should see /operator (the open-report queue +
 * insight views). Same claim mechanism as lib/devMode: a stateless read of the
 * signed session cookie, no DB lookup.
 *
 * Deliberately stricter than getDevMode: there is no config fallback. Without
 * a signing secret the gate (proxy.ts) is inert and anyone can read the
 * cookie-free site, so an operator-only surface must 404 rather than open —
 * "inert gate" must never mean "operator page public". Server-component only
 * (reads cookies()).
 */
export async function getOperatorMode(): Promise<boolean> {
  const secret = config.accessSigningSecret;
  if (!secret) return false;
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  return (await readSessionClaims(secret, cookie))?.operator === true;
}
