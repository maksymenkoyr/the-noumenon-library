import { describe, expect, it } from "vitest";
import { BLAND_CONTROLS, shuffleSentences } from "./controls";
import { mulberry32 } from "./rng";

describe("shuffleSentences", () => {
  const text =
    "The kettle had been whistling for some time. She turned it off. Outside, the first snow was falling.";

  it("returns text with the same sentence set, just reordered", () => {
    const shuffled = shuffleSentences(text, mulberry32(1));
    const originalSentences = text.match(/[^.!?]+[.!?]+/g)!.map((s) => s.trim());
    const shuffledSentences = shuffled.match(/[^.!?]+[.!?]+/g)!.map((s) => s.trim());
    expect(shuffledSentences.slice().sort()).toEqual(originalSentences.slice().sort());
  });

  it("leaves a single-sentence text unchanged", () => {
    const single = "Just one sentence here.";
    expect(shuffleSentences(single, mulberry32(1))).toBe(single);
  });

  it("leaves text with no terminal punctuation unchanged", () => {
    const fragment = "no punctuation at all";
    expect(shuffleSentences(fragment, mulberry32(1))).toBe(fragment);
  });

  it("is deterministic for the same seed", () => {
    expect(shuffleSentences(text, mulberry32(7))).toBe(shuffleSentences(text, mulberry32(7)));
  });
});

describe("BLAND_CONTROLS", () => {
  it("has at least two checked-in fixture texts", () => {
    expect(BLAND_CONTROLS.length).toBeGreaterThanOrEqual(2);
  });

  it("each fixture is non-empty multi-sentence prose", () => {
    for (const fixture of BLAND_CONTROLS) {
      expect(fixture.length).toBeGreaterThan(20);
      expect(fixture.match(/[.!?]/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});
