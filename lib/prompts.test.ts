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
    // Constraints follow the size clause inside the same paragraph. Anchor on
    // text that actually exists — a missing anchor makes indexOf return -1 and
    // the comparison passes vacuously.
    const sizeClause = withConstraints.indexOf("up to about");
    expect(sizeClause).toBeGreaterThan(-1);
    expect(withConstraints.indexOf(constraints[0])).toBeGreaterThan(sizeClause);

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

describe("page shape", () => {
  it("no longer demands a finished whole, and licenses a partial page", () => {
    // The clause "must read as a finished whole — never cut off mid-thought"
    // cancelled the fragment permission beside it: every stored page landed
    // 320-417 words with no fragments at all. A page of a real book is a slice.
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).not.toMatch(/finished whole|never cut off/i);
    expect(prompt).toMatch(/may begin or end\s+mid-sentence/);
  });

  it("states whatever word budget it is given, not a constant", () => {
    // maxWords is drawn per page (lib/generate.ts jitteredMaxWords); the
    // builder must not have 400 baked into it anywhere.
    expect(buildPrompt(DEFAULT_PROMPT_VARIANT, { maxWords: 70 })).toContain("70");
    expect(buildPrompt(DEFAULT_PROMPT_VARIANT, { maxWords: 70 })).not.toContain("400");
  });
});

describe("gallery seed term", () => {
  it("omits the slot entirely when the gallery has no terms", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).not.toMatch(/has to do with/i);
    // No gap left where the omitted sentence would have been (the paragraph
    // break is a newline, so this checks for a doubled space specifically).
    expect(prompt).not.toMatch(/ {2,}/);
  });

  it("states the term loosely, as a fact about the page", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, seedTerm: "oak bark" });
    expect(prompt).toContain("Something on this page has to do with oak bark.");
    // Same rule as the constraints: a fact about the found page, never an
    // order to a writer.
    expect(prompt).not.toMatch(/do not write|avoid|you must/i);
    // Loose on purpose — naming the term as *the subject* turns the page into
    // an encyclopedia entry about it.
    expect(prompt).not.toMatch(/the subject of this page|this page is about/i);
  });

  it("never lets the seed term smuggle the address into the prompt", () => {
    // The hardest invariant: lever *selection* is address-seeded, but the
    // prompt itself never carries a coordinate. The seed term is drawn from
    // the gallery, so this is the one slot that could leak one.
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, seedTerm: "oak bark" });
    expect(prompt).not.toMatch(/\b[a-z0-9-]+\/\d+\/\d+\/\d+\/\d+\b/);
    expect(prompt).not.toMatch(/coordinate/i);
  });
});

describe("entropy dials", () => {
  const DIAL_IDS = [
    "no-persons",
    "no-speech",
    "no-sequence",
    "no-abstraction",
    "no-past",
  ];

  it("carries every dial in the pool", () => {
    const ids = GENERATION_CONSTRAINTS.map((c) => c.id);
    for (const id of DIAL_IDS) expect(ids).toContain(id);
  });

  it("keeps the dials rare enough that the base texture survives", () => {
    for (const id of DIAL_IDS) {
      const dial = GENERATION_CONSTRAINTS.find((c) => c.id === id);
      // Dials only widen the range, so they sit far below the two corrective
      // constraints (0.75) that fix a known failure mode. They stack
      // independently; at 0.15 that means ~14% of pages get two, ~2% three.
      expect(dial?.probability).toBeLessThanOrEqual(0.25);
    }
  });

  it("proscribes rather than prescribes a register", () => {
    // The removed GENERATION_FORMS lever (commit 6d613cc) named a destination
    // ("reads like a prayer") and produced pastiche. Nothing in the pool may
    // tell the page what to be — only what it happens not to contain.
    for (const { text } of GENERATION_CONSTRAINTS) {
      expect(text).not.toMatch(/reads like|in the style of|written as an? /i);
    }
  });

  it("keeps ids unique — they ride into prompt_variant as provenance", () => {
    const ids = GENERATION_CONSTRAINTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
