import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_VARIANT,
  GENERATION_CONSTRAINTS,
  PROMPT_VARIANT_IDS,
  buildPrompt,
  buildPromptSegments,
  joinSegments,
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
    const texts = GENERATION_CONSTRAINTS.map((c) => c.text);
    const withConstraints = buildPrompt(DEFAULT_PROMPT_VARIANT, {
      ...ctx,
      constraints: GENERATION_CONSTRAINTS,
    });
    for (const text of texts) expect(withConstraints).toContain(text);
    // Constraints follow the size clause inside the same paragraph.
    expect(withConstraints.indexOf(texts[0])).toBeGreaterThan(
      withConstraints.indexOf("finished whole"),
    );

    const without = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    for (const text of texts) expect(without).not.toContain(text);
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
    expect(() => buildPromptSegments("does-not-exist", ctx)).toThrow(/unknown prompt variant/i);
  });
});

describe("buildPromptSegments", () => {
  const withAll = { ...ctx, constraints: GENERATION_CONSTRAINTS };

  it("joins back into exactly the prompt that is sent", () => {
    // The segmentation is a view onto the prompt, never a change to it: the
    // dev overlay shows the parts, the model still gets this string.
    for (const c of [ctx, withAll]) {
      expect(joinSegments(buildPromptSegments(DEFAULT_PROMPT_VARIANT, c))).toBe(
        buildPrompt(DEFAULT_PROMPT_VARIANT, c),
      );
    }
    // Framing paragraph, blank line, then the size clause and its constraints
    // as one running paragraph.
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, withAll);
    const [framing, length, ...rest] = buildPromptSegments(DEFAULT_PROMPT_VARIANT, withAll);
    expect(prompt).toBe(
      [framing.text, [length.text, ...rest.map((s) => s.text)].join(" ")].join("\n\n"),
    );
  });

  it("labels every part, and carries each constraint's dial setting", () => {
    expect(buildPromptSegments(DEFAULT_PROMPT_VARIANT, withAll).map((s) => s.id)).toEqual([
      "framing",
      "length",
      ...GENERATION_CONSTRAINTS.map((c) => c.id),
    ]);
    for (const seg of buildPromptSegments(DEFAULT_PROMPT_VARIANT, withAll)) {
      const constraint = GENERATION_CONSTRAINTS.find((c) => c.id === seg.id);
      expect(seg.probability).toBe(constraint?.probability);
    }
  });

  it("emits only framing and length when no constraint fired", () => {
    expect(buildPromptSegments(DEFAULT_PROMPT_VARIANT, ctx).map((s) => s.id)).toEqual([
      "framing",
      "length",
    ]);
  });
});
