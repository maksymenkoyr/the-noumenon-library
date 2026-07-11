import { cookies } from "next/headers";
import { COOKIE_NAME, readSessionClaims } from "./access";
import { config } from "./config";

/**
 * Whether the current request should see the dev overlay (model + generation
 * time; app/[[...address]]/dev-badge). True when either:
 *   - the global config.devMode is on — local dev by default, off in production
 *     (lib/config), so a developer running `next dev` always sees it; or
 *   - the visitor redeemed a dev-flagged invite, whose grant rides in the signed
 *     session cookie (lib/access readSessionClaims) — a stateless read, no DB
 *     lookup, matching the gate's design.
 *
 * With no signing secret (gate inert / public deploy) there is no cookie claim,
 * so only config.devMode can turn it on. Server-component only (reads cookies()).
 */
export async function getDevMode(): Promise<boolean> {
  if (config.devMode) return true;
  const secret = config.accessSigningSecret;
  if (!secret) return false;
  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  return (await readSessionClaims(secret, cookie))?.dev === true;
}
