import { describe, expect, it } from "vitest";
import { readSessionClaims, signSession, verifySession } from "./access";

const SECRET = "test-signing-secret";

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Reproduce the pre-dev-mode cookie format (`<uuid>.<HMAC(secret, uuid)>`) so we
 * can prove old sessions still verify after the format change — nobody is logged
 * out. Mirrors the old signSession's Web Crypto signing.
 */
async function legacyCookie(secret: string, id = crypto.randomUUID()) {
  return `${id}.${await hmacSign(secret, id)}`;
}

/**
 * Reproduce the v1 cookie format (`v1.<devFlag>.<uuid>.<HMAC(...)>`, pre-
 * operator) so we can prove those sessions still verify — operator: false —
 * after the v2 format change.
 */
async function v1Cookie(secret: string, dev: boolean, id = crypto.randomUUID()) {
  const payload = `v1.${dev ? 1 : 0}.${id}`;
  return `${payload}.${await hmacSign(secret, payload)}`;
}

describe("session cookie", () => {
  it("round-trips a default (no grants) session", async () => {
    const cookie = await signSession(SECRET);
    expect(await verifySession(SECRET, cookie)).toBe(true);
    expect(await readSessionClaims(SECRET, cookie)).toEqual({
      dev: false,
      operator: false,
    });
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("round-trips dev=%s operator=%s", async (dev, operator) => {
    const cookie = await signSession(SECRET, { dev, operator });
    expect(await verifySession(SECRET, cookie)).toBe(true);
    expect(await readSessionClaims(SECRET, cookie)).toEqual({ dev, operator });
  });

  it("still accepts a legacy bare-uuid cookie, with no grants", async () => {
    const cookie = await legacyCookie(SECRET);
    expect(await verifySession(SECRET, cookie)).toBe(true);
    expect(await readSessionClaims(SECRET, cookie)).toEqual({
      dev: false,
      operator: false,
    });
  });

  it("still accepts a v1 cookie, with operator false", async () => {
    const cookie = await v1Cookie(SECRET, true);
    expect(await verifySession(SECRET, cookie)).toBe(true);
    expect(await readSessionClaims(SECRET, cookie)).toEqual({
      dev: true,
      operator: false,
    });
  });

  it("rejects a forged or tampered cookie", async () => {
    const cookie = await signSession(SECRET, { dev: true, operator: false });
    // Flip the dev flag without re-signing: signature no longer matches.
    const tampered = cookie.replace("v2.1.0.", "v2.0.0.");
    expect(await verifySession(SECRET, tampered)).toBe(false);
    expect(await readSessionClaims(SECRET, tampered)).toBeNull();

    expect(await verifySession("other-secret", cookie)).toBe(false);
    expect(await readSessionClaims(SECRET, undefined)).toBeNull();
  });

  it("rejects a cookie with the operator flag tampered", async () => {
    const cookie = await signSession(SECRET, { dev: false, operator: false });
    const tampered = cookie.replace("v2.0.0.", "v2.0.1.");
    expect(await verifySession(SECRET, tampered)).toBe(false);
    expect(await readSessionClaims(SECRET, tampered)).toBeNull();
  });
});
