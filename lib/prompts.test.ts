import { describe, expect, it } from "vitest";
import {
  BOOK_PROMPT_VARIANT,
  DEFAULT_PROMPT_VARIANT,
  GENERATION_AXES,
  GENERATION_CONSTRAINTS,
  PROMPT_VARIANT_IDS,
  buildPrompt,
  parseBookMetadata,
} from "./prompts";

const ctx = { maxWords: 400, form: "a ship's log" };

describe("buildPrompt", () => {
  it("states the size constraint, and the default variant carries no form label", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).toContain("400");
    // The not-knowing is re-aimed at the page, not the model.
    expect(prompt).toContain("You do not know what it is");
    // base-v4 dropped the register steer: no "reads like <form>" line, and the
    // supplied form is ignored rather than injected.
    expect(prompt).not.toMatch(/reads like/i);
    expect(prompt).not.toContain("a ship's log");
  });

  it("carries an always-on self-reference guard (base-v6), not a probabilistic one", () => {
    // The "Page N of the Unbound Codex" self-titling tic used to leak whenever
    // the no-library constraint didn't fire; base-v6 makes the guard permanent.
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).toMatch(/does not speak of itself as a page/i);
    expect(prompt).toMatch(/give itself a page number/i);
  });

  it("still injects the form on the register-bearing base variants", () => {
    for (const variant of ["base-v2", "base-v3"]) {
      const prompt = buildPrompt(variant, ctx);
      expect(prompt).toContain("a ship's log");
      expect(prompt).toContain("reads like");
    }
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

  it("appends assembled facts, and omits the slot when none fired", () => {
    const facts = ["Its verbs stay in the present tense.", "Its diction is archaic."];
    const withFacts = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, facts });
    for (const fact of facts) expect(withFacts).toContain(fact);
    // Facts follow the size clause inside the same paragraph.
    expect(withFacts.indexOf(facts[0])).toBeGreaterThan(
      withFacts.indexOf("finished whole"),
    );

    const without = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    for (const fact of facts) expect(without).not.toContain(fact);
    expect(without).not.toMatch(/\s{2,}$/m);
  });

  it("keeps the no-library constraint a fact about the page, not an order", () => {
    const { text, probability } = GENERATION_CONSTRAINTS[0];
    // Phrased as a property of the found page (transcriber framing holds).
    expect(text).toMatch(/happens to contain no mention/i);
    expect(text).not.toMatch(/do not write|avoid|you must/i);
    // The self-reference guard moved out to the always-on base-v6 line — this
    // constraint is purely about library content now.
    expect(text).not.toMatch(/speak of itself|address(es)? the|reading it/i);
    expect(probability).toBeGreaterThan(0);
    expect(probability).toBeLessThan(1);
  });

  it("renders every axis option as a fact, never a label, order, or named genre", () => {
    for (const axis of GENERATION_AXES) {
      expect(axis.applyProbability).toBeGreaterThan(0);
      expect(axis.applyProbability).toBeLessThanOrEqual(1);
      expect(axis.options.length).toBeGreaterThan(0);
      // base-v6 steers with low-level primitives only — no top-down genre axis.
      expect(axis.name).not.toBe("register");
      for (const option of axis.options) {
        const fact = axis.render(option);
        expect(fact).toContain(option);
        // A statement about the found page — not "reads like", not a command.
        expect(fact).not.toMatch(/reads like|write |you must|do not/i);
        expect(fact.trim()).toMatch(/\.$/);
      }
    }
  });

  it("throws on an unknown variant", () => {
    expect(() => buildPrompt("does-not-exist", ctx)).toThrow(/unknown prompt variant/i);
  });
});

describe("book-v1 (books experiment)", () => {
  const prev = "The ship left harbor at dawn.\n…\nNo one watched it go.";
  const next = "By morning the coast was gone.\n…\nThe log ends here.";
  const cases = [
    { name: "no neighbors", ctx: { ...ctx } },
    { name: "continue-from-prev", ctx: { ...ctx, prev } },
    { name: "continue-into-next", ctx: { ...ctx, next } },
    { name: "bridge", ctx: { ...ctx, prev, next } },
  ];

  it("registers the variant", () => {
    expect(PROMPT_VARIANT_IDS).toContain(BOOK_PROMPT_VARIANT);
  });

  it.each(cases)("$name: injects the form, never an address or page-self framing", ({ ctx: c }) => {
    const prompt = buildPrompt(BOOK_PROMPT_VARIANT, c);
    expect(prompt).toContain("a ship's log");
    expect(prompt).toContain("400");
    // The locality lessons: no coordinates, model reads rather than *is* a page.
    expect(prompt).not.toMatch(/\b[a-z0-9-]+\/\d+\/\d+\/\d+\/\d+\b/);
    expect(prompt).not.toMatch(/you are a page/i);
    expect(prompt).not.toMatch(/coordinate/i);
  });

  it("injects the condensed neighbors with a no-repeat clause", () => {
    const fromPrev = buildPrompt(BOOK_PROMPT_VARIANT, { ...ctx, prev });
    expect(fromPrev).toContain(prev);
    expect(fromPrev).toMatch(/without repeating/i);

    const intoNext = buildPrompt(BOOK_PROMPT_VARIANT, { ...ctx, next });
    expect(intoNext).toContain(next);
    expect(intoNext).toMatch(/without quoting/i);

    const bridge = buildPrompt(BOOK_PROMPT_VARIANT, { ...ctx, prev, next });
    expect(bridge).toContain(prev);
    expect(bridge).toContain(next);
    expect(bridge).toMatch(/without repeating, quoting, or remarking/i);
  });

  it("only the unconstrained cases demand a finished whole", () => {
    // With a fixed next opening the ending is constrained — the instructions
    // must not contradict each other.
    expect(buildPrompt(BOOK_PROMPT_VARIANT, { ...ctx })).toMatch(/finished whole/i);
    expect(buildPrompt(BOOK_PROMPT_VARIANT, { ...ctx, next })).not.toMatch(/finished whole/i);
    expect(buildPrompt(BOOK_PROMPT_VARIANT, { ...ctx, prev, next })).not.toMatch(/finished whole/i);
  });
});

describe("parseBookMetadata", () => {
  it("parses a clean reply", () => {
    expect(
      parseBookMetadata("TITLE: The Salt Ledger\nTAGS: sea, debt, weather"),
    ).toEqual({ title: "The Salt Ledger", tags: ["sea", "debt", "weather"] });
  });

  it("tolerates reasoning preamble and markdown dressing", () => {
    const reply = [
      "Let me think about this page.",
      "It reads like a maritime record.",
      "**TITLE:** \"The Salt Ledger\"",
      "**TAGS:** sea; debt; weather",
    ].join("\n");
    expect(parseBookMetadata(reply)).toEqual({
      title: "The Salt Ledger",
      tags: ["sea", "debt", "weather"],
    });
  });

  it("caps tags at five and drops empties", () => {
    const parsed = parseBookMetadata("TITLE: T\nTAGS: a,, b, c, d, e, f, g");
    expect(parsed?.tags).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("accepts a title without tags", () => {
    expect(parseBookMetadata("TITLE: Only a Title")).toEqual({
      title: "Only a Title",
      tags: [],
    });
  });

  it("returns null when no usable title exists", () => {
    expect(parseBookMetadata(null)).toBeNull();
    expect(parseBookMetadata("")).toBeNull();
    expect(parseBookMetadata("I could not decide on anything.")).toBeNull();
    expect(parseBookMetadata("TAGS: a, b")).toBeNull();
  });
});
