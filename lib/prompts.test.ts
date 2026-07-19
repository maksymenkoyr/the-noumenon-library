import { describe, expect, it } from "vitest";
import {
  BOOK_PROMPT_VARIANT,
  DEFAULT_PROMPT_VARIANT,
  PROMPT_VARIANT_IDS,
  buildPrompt,
  parseBookMetadata,
} from "./prompts";

const ctx = { maxWords: 400 };

describe("buildPrompt", () => {
  it("states the size constraint", () => {
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

  it.each(cases)("$name: never an address or page-self framing", ({ ctx: c }) => {
    const prompt = buildPrompt(BOOK_PROMPT_VARIANT, c);
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
