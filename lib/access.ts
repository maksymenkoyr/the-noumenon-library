/**
 * Private-access gate (proxy.ts + app/api/access). The whole site is gated
 * behind an invite link when ACCESS_SIGNING_SECRET is set. An invite token
 * (scripts/invite.mjs, unique per person) is reusable across devices; each
 * redemption drops an HMAC-signed session cookie so that browser wanders freely
 * (docs: private-share deploy).
 *
 * The session cookie is stateless: `<payload>.<HMAC(secret, payload)>`, where
 * the payload is `v1.<devFlag>.<uuid>` — the random UUID keeps each session
 * unique, and the flag carries the invite's dev-mode grant (readSessionClaims)
 * so a per-request check needs no DB lookup. The proxy verifies the signature
 * with Web Crypto only (no DB, no per-request lookup), so it stays cheap and
 * runtime-portable. Token validity is checked in the DB at redemption, not here.
 * Legacy bare-`<uuid>` payloads still verify, so no session is logged out by the
 * format change.
 *
 * Honest limits (see the design discussion): access is a shared bearer secret.
 * The invite link is reusable and the session cookie is copyable, so anyone the
 * link (or cookie) reaches gets in. This is a soft "keep it private" gate for
 * trusted sharing, not real access control; that would need accounts / passkeys.
 */

export const COOKIE_NAME = "nl_session";

const encoder = new TextEncoder();

/** URL-safe base64 of raw bytes (no padding). */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64url(new Uint8Array(sig));
}

/** Constant-time string compare (equal length + XOR fold). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Claims carried, signed, inside the session cookie. */
export interface SessionClaims {
  /** The visitor redeemed a dev-flagged invite → sees the dev overlay. */
  dev: boolean;
}

const PAYLOAD_VERSION = "v1";

/**
 * Mint a fresh signed session value to store in the cookie. The signed payload
 * is `v1.<devFlag>.<uuid>`: the random UUID makes every session value unique,
 * the flag records the invite's dev grant so no later request needs a DB lookup.
 */
export async function signSession(
  secret: string,
  claims: Partial<SessionClaims> = {},
): Promise<string> {
  const payload = `${PAYLOAD_VERSION}.${claims.dev ? 1 : 0}.${crypto.randomUUID()}`;
  const sig = await hmac(secret, payload);
  return `${payload}.${sig}`;
}

/** Verify a cookie value was signed by `secret`. */
export async function verifySession(
  secret: string,
  value: string | undefined,
): Promise<boolean> {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  return timingSafeEqual(sig, await hmac(secret, payload));
}

/**
 * Verify a cookie and read its claims — null for a missing/forged value. A valid
 * legacy cookie (bare `<uuid>` payload, minted before the format change) verifies
 * with `dev: false`; only a `v1.<flag>.<uuid>` payload carries a real grant.
 */
export async function readSessionClaims(
  secret: string,
  value: string | undefined,
): Promise<SessionClaims | null> {
  if (!(await verifySession(secret, value))) return null;
  const payload = value!.slice(0, value!.lastIndexOf("."));
  const parts = payload.split(".");
  // A UUID has no dots, so a legacy payload splits to one part; the versioned
  // payload splits to exactly three with the version marker leading.
  if (parts.length === 3 && parts[0] === PAYLOAD_VERSION) {
    return { dev: parts[1] === "1" };
  }
  return { dev: false };
}

/** Minimal "this is private" page, shown to any request without a valid session. */
export const GATE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>The Noumenon Library</title><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0b0b0c;color:#e8e6e1;font-family:Georgia,'Times New Roman',serif;padding:2rem}main{max-width:32rem;text-align:center;line-height:1.6}h1{font-weight:400;font-size:1.6rem;letter-spacing:.02em;margin:0 0 1rem}p{opacity:.7;margin:0}</style></head><body><main><h1>The Noumenon Library</h1><p>This library is private. It opens only to an invitation.</p></main></body></html>`;
