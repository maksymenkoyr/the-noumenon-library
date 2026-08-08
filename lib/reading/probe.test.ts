import { describe, expect, it } from "vitest";
import { pickRecognitionProbe } from "./probe";
import { mulberry32 } from "./rng";

const PAGE_LINES = [
  "The kettle had been whistling for some time.",
  "She turned it off and stood in the sudden quiet.",
  "Outside, the first snow of the year was falling.",
];
const DECOY_POOL = [
  "He counted the coins twice before handing them over.",
  "The train was late again, as it always was in winter.",
  "Nobody answered when she called his name a second time.",
  "The garden had gone to seed years before anyone noticed.",
];

describe("pickRecognitionProbe", () => {
  it("builds a usable probe with the truth line among the four options", () => {
    const result = pickRecognitionProbe(PAGE_LINES, [], DECOY_POOL, mulberry32(1));
    expect(result.usable).toBe(true);
    expect(result.options).toHaveLength(4);
    const truth = result.options[result.correctIndex];
    expect(PAGE_LINES.map((l) => l.trim())).toContain(truth);
  });

  it("excludes an already-quoted line from the pool of possible truths", () => {
    // Quote two of the three lines; the probe must not use either as truth.
    const alreadyQuoted = [PAGE_LINES[0], PAGE_LINES[1]];
    const result = pickRecognitionProbe(PAGE_LINES, alreadyQuoted, DECOY_POOL, mulberry32(2));
    expect(result.usable).toBe(true);
    const truth = result.options[result.correctIndex];
    expect(truth).toBe(PAGE_LINES[2]);
  });

  it("is unusable when every line has already been quoted", () => {
    const result = pickRecognitionProbe(PAGE_LINES, PAGE_LINES, DECOY_POOL, mulberry32(3));
    expect(result.usable).toBe(false);
  });

  it("is unusable when fewer than 3 decoys are available", () => {
    const result = pickRecognitionProbe(PAGE_LINES, [], DECOY_POOL.slice(0, 2), mulberry32(4));
    expect(result.usable).toBe(false);
  });

  it("never lets the truth line double as one of its own decoys", () => {
    // Decoy pool intentionally contains a duplicate of a page line — must be
    // filtered out so the same text can't appear at two option slots.
    const dupedPool = [...DECOY_POOL, PAGE_LINES[0]];
    const result = pickRecognitionProbe(PAGE_LINES, [], dupedPool, mulberry32(5));
    const options = result.options.map((o) => o.trim());
    const occurrences = options.filter((o) => o === PAGE_LINES[0].trim()).length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });

  it("is deterministic for the same seed", () => {
    const a = pickRecognitionProbe(PAGE_LINES, [], DECOY_POOL, mulberry32(42));
    const b = pickRecognitionProbe(PAGE_LINES, [], DECOY_POOL, mulberry32(42));
    expect(a).toEqual(b);
  });

  it("is unusable rather than throwing on an empty page", () => {
    expect(() => pickRecognitionProbe([], [], DECOY_POOL, mulberry32(6))).not.toThrow();
    expect(pickRecognitionProbe([], [], DECOY_POOL, mulberry32(6)).usable).toBe(false);
  });
});
