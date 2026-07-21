import { describe, expect, it } from "vitest";
import { likedKey, LIKED_PREFIX, parseLikedEntry } from "./liked";

describe("likedKey", () => {
  it("prefixes the canonical address", () => {
    expect(likedKey("io-9/3/2/17/308")).toBe(`${LIKED_PREFIX}io-9/3/2/17/308`);
  });
});

describe("parseLikedEntry", () => {
  it("round-trips a timestamped like mark", () => {
    const now = Date.now();
    expect(parseLikedEntry(likedKey("io-9/3/2/17/308"), String(now))).toEqual({
      address: "io-9/3/2/17/308",
      likedAt: now,
    });
  });

  it('treats a legacy "1" mark as liked, sorting older than real marks', () => {
    const entry = parseLikedEntry(likedKey("io-9/3/2/17/308"), "1");
    expect(entry?.address).toBe("io-9/3/2/17/308");
    expect(entry!.likedAt).toBeLessThan(Date.now() - 1000);
  });

  it("treats a non-numeric value as liked at 0", () => {
    expect(parseLikedEntry(likedKey("io-9/3/2/17/308"), "yes")).toEqual({
      address: "io-9/3/2/17/308",
      likedAt: 0,
    });
  });

  it("ignores foreign localStorage keys", () => {
    expect(parseLikedEntry("noumenon:arrived-via", "next")).toBeNull();
    expect(parseLikedEntry("theme", "dark")).toBeNull();
  });

  it("ignores keys whose suffix is not a canonical address", () => {
    expect(parseLikedEntry(`${LIKED_PREFIX}not-an-address`, "1")).toBeNull();
    expect(parseLikedEntry(`${LIKED_PREFIX}io-9/3/2/17/0`, "1")).toBeNull();
    expect(parseLikedEntry(`${LIKED_PREFIX}IO-9/03/2/17/308`, "1")).toBeNull();
  });

  it("ignores a null value", () => {
    expect(parseLikedEntry(likedKey("io-9/3/2/17/308"), null)).toBeNull();
  });
});
