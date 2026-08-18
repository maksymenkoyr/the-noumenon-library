import { describe, expect, it } from "vitest";
import { DAMAGES, applyDamage, pickDamage } from "./pageDamage";

/** `n` words of predictable, 4-letter filler — mirrors lib/pageCut.test.ts. */
const filler = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const words = (s: string) => s.trim().split(/\s+/);

/**
 * Three unique tokens pinned to each edge, so "the edge guard held" is
 * checkable directly from the output string without knowing which words a
 * seeded draw happened to pick.
 */
const withGuardedEdges = (n: number) => `A1 A2 A3 ${filler(n)} Z1 Z2 Z3`;

const KINDS = ["lacuna", "effaced", "stutter"] as const;

describe("DAMAGES", () => {
  it("keeps damage a rare texture, not a default", () => {
    const total = DAMAGES.reduce((sum, o) => sum + o.weight, 0);
    const none = DAMAGES.find((o) => o.id === "none")!;
    expect(none.weight / total).toBeCloseTo(0.85);
  });

  it("holds stutter far rarer than the others — the one glitch-not-relic entry", () => {
    const total = DAMAGES.reduce((sum, o) => sum + o.weight, 0);
    const stutter = DAMAGES.find((o) => o.id === "stutter")!;
    expect(stutter.weight / total).toBeCloseTo(0.01);
  });
});

describe("pickDamage", () => {
  it("draws every damage kind given enough samples, and is deterministic", () => {
    let seed = 1;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const drawn = new Set(Array.from({ length: 400 }, () => pickDamage(rng).id));
    expect(drawn.size).toBe(4);

    const fixed = () => 0.5;
    expect(pickDamage(fixed).id).toBe(pickDamage(fixed).id);
  });
});

describe("applyDamage", () => {
  it("leaves the text alone under 'none'", () => {
    const text = withGuardedEdges(40);
    expect(applyDamage(text, "none")).toEqual({ text, damage: "none" });
  });

  it("downgrades to 'none' on a page too short to damage safely", () => {
    const text = filler(9); // MIN_WORDS_FOR_DAMAGE is 10 — one short
    for (const damage of KINDS) {
      expect(applyDamage(text, damage)).toEqual({ text, damage: "none" });
    }
  });

  it("is deterministic — the same stored text always damages the same way", () => {
    const text = withGuardedEdges(60);
    for (const damage of KINDS) {
      expect(applyDamage(text, damage)).toEqual(applyDamage(text, damage));
    }
  });

  describe("every damage kind", () => {
    it("never touches the guarded edge words", () => {
      for (const damage of KINDS) {
        for (let n = 20; n <= 200; n += 15) {
          const r = applyDamage(withGuardedEdges(n), damage);
          expect(r.text.startsWith("A1 A2 A3")).toBe(true);
          expect(r.text.endsWith("Z1 Z2 Z3")).toBe(true);
        }
      }
    });

    it("changes the text when it fires, and reports the kind that fired", () => {
      for (const damage of KINDS) {
        const text = withGuardedEdges(60);
        const r = applyDamage(text, damage);
        expect(r.text).not.toBe(text);
        expect(r.damage).toBe(damage);
      }
    });
  });

  describe("lacuna", () => {
    it("replaces one contiguous span with a single mark", () => {
      const r = applyDamage(withGuardedEdges(60), "lacuna");
      const marks = r.text.match(/·+/g) ?? [];
      expect(marks.length).toBe(1);
      expect(marks[0]?.length).toBeGreaterThanOrEqual(3);
      expect(marks[0]?.length).toBeLessThanOrEqual(8);
    });

    it("never widens the word count — a span of 1–3 collapses to one mark", () => {
      const text = withGuardedEdges(60);
      const before = words(text).length;
      const after = words(applyDamage(text, "lacuna").text).length;
      // span is 1–3 words replaced by exactly one mark token: before, -1, or -2.
      expect(after).toBeLessThanOrEqual(before);
      expect(after).toBeGreaterThanOrEqual(before - 2);
    });

    it("uses no editorial bracket — the fiction has no transcriber", () => {
      const r = applyDamage(withGuardedEdges(60), "lacuna");
      expect(r.text).not.toMatch(/\[.*\]/);
    });
  });

  describe("effaced", () => {
    it("scatters more than one mark across a long enough page", () => {
      const r = applyDamage(withGuardedEdges(200), "effaced");
      const marks = r.text.match(/·+/g) ?? [];
      expect(marks.length).toBeGreaterThan(1);
      for (const m of marks) {
        expect(m.length).toBeGreaterThanOrEqual(3);
        expect(m.length).toBeLessThanOrEqual(8);
      }
    });

    it("keeps the word count unchanged — words are worn away, not removed", () => {
      const text = withGuardedEdges(120);
      const before = words(text).length;
      const after = words(applyDamage(text, "effaced").text).length;
      expect(after).toBe(before);
    });
  });

  describe("stutter", () => {
    it("only prefixes the phrase it echoes — nothing downstream is deleted", () => {
      const text = withGuardedEdges(60);
      const r = applyDamage(text, "stutter");
      expect(r.text.length).toBeGreaterThan(text.length);
      expect(r.text.startsWith("A1 A2 A3")).toBe(true);
      expect(r.text.endsWith("Z1 Z2 Z3")).toBe(true);
    });

    it("never introduces the damage-mark character — a glitch, not a wound", () => {
      expect(applyDamage(withGuardedEdges(60), "stutter").text).not.toMatch(/·/);
    });
  });
});
