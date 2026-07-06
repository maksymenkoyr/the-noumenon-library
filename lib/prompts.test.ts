import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_VARIANT,
  PROMPT_VARIANT_IDS,
  buildPrompt,
} from "./prompts";

const ctx = { maxWords: 400, form: "a ship's log" };

describe("buildPrompt", () => {
  it("states the size constraint and injects the chosen form", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).toContain("400");
    expect(prompt).toContain("a ship's log");
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
  });

  it("throws on an unknown variant", () => {
    expect(() => buildPrompt("does-not-exist", ctx)).toThrow(/unknown prompt variant/i);
  });
});
