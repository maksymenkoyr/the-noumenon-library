import { cookies } from "next/headers";
import { COOKIE_NAME, readSessionClaims } from "./access";
import { config } from "./config";

/**
 * Whether the current request should see /operator (the open-report queue +
 * insight views). Same claim mechanism as lib/devMode: a stateless read of the
 * signed session cookie, no DB lookup.
 *
 * Deliberately stricter than getDevMode: there is no config fallback. The
 * gate (proxy.ts) can go inert two ways — no signing secret at all, or a
 * secret present but ACCESS_GATE_ENABLED=false (the public deploy) — and
 * either way anyone can read the cookie-free site. An operator-only surface
 * must 404 rather than open in both cases, so this checks the secret alone
 * and ignores the gate-enabled flag entirely: "gate open to the public" must
 * never mean "operator page public". Server-component only (reads cookies()).
 */
export async function getOperatorMode(): Promise<boolean> {
  const secret = config.accessSigningSecret;
  if (!secret) return false;
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  return (await readSessionClaims(secret, cookie))?.operator === true;
}
