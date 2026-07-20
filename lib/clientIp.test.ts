import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Proves the fix in lib/clientIp.ts: x-forwarded-for's leftmost entry is
 * client-supplied and must never be trusted, since Vercel appends the real
 * connecting IP rather than replacing a client-set header. x-real-ip (or the
 * last XFF hop, as a fallback) is the only thing that can't be spoofed by the
 * request sender.
 */

let currentHeaders: Record<string, string>;

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => currentHeaders[name.toLowerCase()] ?? null,
  }),
}));

import { getClientIp } from "./clientIp";

afterEach(() => {
  currentHeaders = {};
});

describe("getClientIp", () => {
  it("ignores a spoofed leftmost x-forwarded-for when x-real-ip is present", async () => {
    currentHeaders = {
      "x-forwarded-for": "1.2.3.4, 9.9.9.9", // 1.2.3.4 is attacker-controlled
      "x-real-ip": "9.9.9.9",
    };
    expect(await getClientIp()).toBe("9.9.9.9");
  });

  it("returns x-real-ip when there is no x-forwarded-for", async () => {
    currentHeaders = { "x-real-ip": "203.0.113.7" };
    expect(await getClientIp()).toBe("203.0.113.7");
  });

  it("falls back to the last x-forwarded-for hop, not the first, when x-real-ip is absent", async () => {
    currentHeaders = { "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.9" };
    expect(await getClientIp()).toBe("203.0.113.9");
  });

  it("returns undefined when neither header is present", async () => {
    currentHeaders = {};
    expect(await getClientIp()).toBeUndefined();
  });
});
