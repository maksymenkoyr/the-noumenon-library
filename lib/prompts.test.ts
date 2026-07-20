import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_VARIANT,
  GENERATION_CONSTRAINTS,
  PROMPT_VARIANT_IDS,
  buildPrompt,
} from "./prompts";

const ctx = { maxWords: 400 };

describe("buildPrompt", () => {
  it("states the size constraint and the transcriber framing", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).toContain("400");
    // The not-knowing is re-aimed at the page, not the model.
    expect(prompt).toContain("You do not know what it is");
  });

  it("does not tell the page its address, and keeps the model as transcriber", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).not.toMatch(/coordinate/i);
    expect(prompt).not.toMatch(/a word surfaces/i);
    // No address-shaped token (e.g. io-9/3/2/17/308).
    expect(prompt).not.toMatch(/\b[a-z0-9-]+\/\d+\/\d+\/\d+\/\d+\b/);
    // The model is reading/transcribing a found page, not "being" one.
    expect(prompt).not.toMatch(/you are a page/i);
  });

  it("exposes the default variant in the registry", () => {
    expect(PROMPT_VARIANT_IDS).toContain(DEFAULT_PROMPT_VARIANT);
    expect(DEFAULT_PROMPT_VARIANT).toBe("base-v1");
  });

  it("appends sampled constraints, and omits the slot when none fired", () => {
    const constraints = GENERATION_CONSTRAINTS.map((c) => c.text);
    const withConstraints = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, constraints });
    for (const text of constraints) expect(withConstraints).toContain(text);
    // Constraints follow the size clause inside the same paragraph.
    expect(withConstraints.indexOf(constraints[0])).toBeGreaterThan(
      withConstraints.indexOf("finished whole"),
    );

    const without = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    for (const text of constraints) expect(without).not.toContain(text);
    expect(without).not.toMatch(/\s{2,}$/m);
  });

  it("keeps every constraint a fact about the page, not an order", () => {
    for (const { text, probability } of GENERATION_CONSTRAINTS) {
      // Phrased as a property of the found page (transcriber framing holds).
      expect(text).not.toMatch(/do not write|avoid|you must/i);
      expect(probability).toBeGreaterThan(0);
      expect(probability).toBeLessThan(1);
    }
  });

  it("keeps the no-library constraint about library content specifically", () => {
    const constraint = GENERATION_CONSTRAINTS.find((c) => c.id === "no-library");
    expect(constraint?.text).toMatch(/happens to contain no mention/i);
  });

  it("guards against the page self-titling or addressing the reader", () => {
    const constraint = GENERATION_CONSTRAINTS.find((c) => c.id === "self-reference");
    expect(constraint?.text).toMatch(/does not speak of itself as a page/i);
    expect(constraint?.text).toMatch(/give itself a page number/i);
  });

  it("throws on an unknown variant", () => {
    expect(() => buildPrompt("does-not-exist", ctx)).toThrow(/unknown prompt variant/i);
  });
});
