import { describe, expect, it } from "vitest";
import { mulberry32, pickOne, seedFromString, shuffle } from "./rng";

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("differs for different seeds (overwhelmingly likely)", () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toBe(b);
  });

  it("stays within [0, 1)", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("seedFromString", () => {
  it("is deterministic for the same string", () => {
    expect(seedFromString("io-9/3/2/17/308")).toBe(seedFromString("io-9/3/2/17/308"));
  });

  it("differs for different strings (overwhelmingly likely)", () => {
    expect(seedFromString("io-9/3/2/17/308")).not.toBe(seedFromString("io-9/3/2/17/309"));
  });
});

describe("shuffle", () => {
  it("preserves every element (a permutation, not a resample)", () => {
    const items = [1, 2, 3, 4, 5];
    const shuffled = shuffle(items, mulberry32(1));
    expect(shuffled.slice().sort()).toEqual(items.slice().sort());
  });

  it("does not mutate the input array", () => {
    const items = [1, 2, 3];
    const copy = items.slice();
    shuffle(items, mulberry32(1));
    expect(items).toEqual(copy);
  });

  it("is deterministic for the same seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffle(items, mulberry32(99))).toEqual(shuffle(items, mulberry32(99)));
  });
});

describe("pickOne", () => {
  it("always returns an item from the list", () => {
    const items = ["a", "b", "c"];
    const rng = mulberry32(5);
    for (let i = 0; i < 20; i++) {
      expect(items).toContain(pickOne(items, rng));
    }
  });
});
