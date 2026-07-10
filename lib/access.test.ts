import { describe, expect, it } from "vitest";
import { readSessionClaims, signSession, verifySession } from "./access";

const SECRET = "test-signing-secret";

/**
 * Reproduce the pre-dev-mode cookie format (`<uuid>.<HMAC(secret, uuid)>`) so we
 * can prove old sessions still verify after the format change — nobody is logged
 * out. Mirrors the old signSession's Web Crypto signing.
 */
async function legacyCookie(secret: string, id = crypto.randomUUID()) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(id),
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${id}.${b64}`;
}

describe("session cookie", () => {
  it("round-trips a default (non-dev) session", async () => {
    const cookie = await signSession(SECRET);
    expect(await verifySession(SECRET, cookie)).toBe(true);
    expect(await readSessionClaims(SECRET, cookie)).toEqual({ dev: false });
  });

  it("carries the dev grant when signed with it", async () => {
    const cookie = await signSession(SECRET, { dev: true });
    expect(await verifySession(SECRET, cookie)).toBe(true);
    expect(await readSessionClaims(SECRET, cookie)).toEqual({ dev: true });
  });

  it("still accepts a legacy bare-uuid cookie, with no dev grant", async () => {
    const cookie = await legacyCookie(SECRET);
    expect(await verifySession(SECRET, cookie)).toBe(true);
    expect(await readSessionClaims(SECRET, cookie)).toEqual({ dev: false });
  });

  it("rejects a forged or tampered cookie", async () => {
    const cookie = await signSession(SECRET, { dev: true });
    // Flip the dev flag without re-signing: signature no longer matches.
    const tampered = cookie.replace("v1.1.", "v1.0.");
    expect(await verifySession(SECRET, tampered)).toBe(false);
    expect(await readSessionClaims(SECRET, tampered)).toBeNull();

    expect(await verifySession("other-secret", cookie)).toBe(false);
    expect(await readSessionClaims(SECRET, undefined)).toBeNull();
  });
});
