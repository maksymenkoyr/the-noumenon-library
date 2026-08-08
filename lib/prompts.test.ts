import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_VARIANT,
  GENERATION_CONSTRAINTS,
  OVERSHOOT,
  PROMPT_VARIANT_IDS,
  START_SEAMS,
  buildPrompt,
  pickStartSeam,
} from "./prompts";

const ctx = { pageWords: 200 };

describe("buildPrompt", () => {
  it("asks for more than a page, so there is always something to cut", () => {
    // The page size itself must never appear: it is what the text is cut down
    // to (lib/pageCut.ts), not what the model aims at.
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).toContain(`about ${Math.round(200 * OVERSHOOT)} words`);
    expect(prompt).not.toMatch(/\b200\b/);
    expect(OVERSHOOT).toBeGreaterThan(1);
  });

  it("never states an ending — that is the whole redesign", () => {
    // base-v2 asked for one. Given "Generate 400 words … At 400 words it runs
    // out of room and stops mid-sentence" a live model returned 531, 503, 724
    // and 777 words. Models cannot count, so the ending left the prompt.
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, {
      ...ctx,
      seedTerm: "oak bark",
      constraints: GENERATION_CONSTRAINTS.map((c) => c.text),
    });
    expect(prompt).not.toMatch(/runs out of room|it ends|and ends|stops mid/i);
  });

  it("asks for a finished text only under the complete ending", () => {
    const complete = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, completeWords: 60 });
    expect(complete).toContain("about 60 words of text, complete in itself.");
    // …and that length replaces the overshoot rather than adding to it.
    expect(complete).not.toContain(`${Math.round(200 * OVERSHOOT)}`);
    expect(buildPrompt(DEFAULT_PROMPT_VARIANT, ctx)).not.toContain("complete in itself");
  });

  it("forbids marking the opening with an ellipsis", () => {
    // Left alone the model signposts the seam with a leading "…", a narrator
    // saying *this is an excerpt*. lib/pageCut.ts strips them regardless.
    expect(buildPrompt(DEFAULT_PROMPT_VARIANT, ctx)).toContain(
      "The opening is not marked with an ellipsis.",
    );
  });

  it("never carries the address, and never makes the model the text", () => {
    // The hardest invariant: lever *selection* is address-seeded, but the
    // prompt itself never names a coordinate.
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, {
      ...ctx,
      seedTerm: "oak bark",
      constraints: GENERATION_CONSTRAINTS.map((c) => c.text),
    });
    expect(prompt).not.toMatch(/coordinate/i);
    expect(prompt).not.toMatch(/\b[a-z0-9-]+\/\d+\/\d+\/\d+\/\d+\b/);
    // The old framing made the model narrate *being* a page ("I am a page,
    // thin and quiet…"). Nothing may reintroduce it.
    expect(prompt).not.toMatch(/you are a page/i);
  });

  it("exposes the default variant in the registry", () => {
    expect(PROMPT_VARIANT_IDS).toContain(DEFAULT_PROMPT_VARIANT);
    // Bumped on every material rewrite: reusing an id would make provenance
    // lie, since rows recording base-v2 were written to a prompt that still
    // asked for an ending.
    expect(DEFAULT_PROMPT_VARIANT).toBe("base-v3");
  });

  it("stays terse — the whole point of the trim", () => {
    // Base was 74 words, and ~114 on a typical page once the two 0.75
    // correctives fired. Dropping the ending clause bought some of that back.
    const base = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(base.trim().split(/\s+/).length).toBeLessThan(25);
    // No trace of the retired premise.
    expect(base).not.toMatch(/library|shelf|archive|page/i);
  });

  it("appends sampled constraints, and omits the slot when none fired", () => {
    const constraints = GENERATION_CONSTRAINTS.map((c) => c.text);
    const withConstraints = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, constraints });
    for (const text of constraints) expect(withConstraints).toContain(text);
    // Constraints follow the parameter sentences. Anchor on text that actually
    // exists — a missing anchor makes indexOf return -1 and the comparison
    // passes vacuously.
    const edges = withConstraints.indexOf("It begins");
    expect(edges).toBeGreaterThan(-1);
    expect(withConstraints.indexOf(constraints[0])).toBeGreaterThan(edges);

    const without = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    for (const text of constraints) expect(without).not.toContain(text);
    expect(without).not.toMatch(/ {2,}/);
  });

  it("keeps every constraint a fact about the text, not an order", () => {
    for (const { text, probability } of GENERATION_CONSTRAINTS) {
      expect(text).not.toMatch(/do not write|avoid|you must/i);
      expect(probability).toBeGreaterThan(0);
      expect(probability).toBeLessThan(1);
    }
  });

  it("has dropped the two correctives along with the premise that caused them", () => {
    const ids = GENERATION_CONSTRAINTS.map((c) => c.id);
    // no-library suppressed the theme the old opener primed; self-reference
    // stopped the model titling itself "Page 47,821,903". Neither has anything
    // left to correct.
    expect(ids).not.toContain("no-library");
    expect(ids).not.toContain("self-reference");
    expect(ids).toEqual([
      "no-persons",
      "no-speech",
      "no-sequence",
      "no-abstraction",
      "no-past",
    ]);
  });

  it("proscribes rather than prescribes a register", () => {
    // The removed GENERATION_FORMS lever (commit 6d613cc) named a destination
    // ("reads like a prayer") and produced pastiche. Nothing in the pool may
    // tell the text what to be — only what it happens not to contain.
    for (const { text } of GENERATION_CONSTRAINTS) {
      expect(text).not.toMatch(/reads like|in the style of|written as an? /i);
    }
  });

  it("keeps ids unique — they ride into prompt_variant as provenance", () => {
    const ids = GENERATION_CONSTRAINTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("throws on an unknown variant", () => {
    expect(() => buildPrompt("does-not-exist", ctx)).toThrow(/unknown prompt variant/i);
  });
});

describe("start seams", () => {
  it("reads correctly for every seam", () => {
    for (const option of START_SEAMS) {
      const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, start: option.phrase });
      expect(prompt).toContain(`It begins ${option.phrase}.`);
    }
  });

  it("has no counterpart pool for the bottom of the page", () => {
    // The asymmetry is the point: the model obeys a start instruction ("begins
    // mid-word" → *"mentary evidence suggests…"*) and cannot obey an ending
    // one, so the ending is computed instead (lib/pageCut.ts).
    for (const option of START_SEAMS) {
      expect(option).not.toHaveProperty("endPhrase");
    }
  });

  it("carries the four seams, with mid-word the rarest", () => {
    expect([...START_SEAMS.map((o) => o.id)].sort()).toEqual([
      "mid-paragraph",
      "mid-sentence",
      "mid-word",
      "paragraph-break",
    ]);
    const midWord = START_SEAMS.find((o) => o.id === "mid-word");
    for (const other of START_SEAMS) {
      if (other.id !== "mid-word") {
        // mid-word is the most authentic to a real page break and the most
        // likely to read as a broken generation — it stays rare.
        expect(midWord!.weight).toBeLessThan(other.weight);
      }
    }
  });

  it("keeps a clean opening in the minority", () => {
    // paragraph-break is the only seam that lets the model write a proper
    // first line, and given the chance it writes *"The old lighthouse keeper
    // had not spoken in three days."* — a fine opening and a terrible page.
    const total = START_SEAMS.reduce((sum, o) => sum + o.weight, 0);
    const clean = START_SEAMS.find((o) => o.id === "paragraph-break")!;
    expect(clean.weight / total).toBeLessThan(0.25);
  });

  it("draws every seam given enough samples, and is deterministic", () => {
    let seed = 1;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const drawn = new Set(Array.from({ length: 200 }, () => pickStartSeam(rng).id));
    expect(drawn.size).toBe(4);

    // Same stream position → same draw.
    const fixed = () => 0.01;
    expect(pickStartSeam(fixed).id).toBe(pickStartSeam(fixed).id);
  });

  it("defaults to a valid prompt when a caller omits the seam", () => {
    expect(buildPrompt(DEFAULT_PROMPT_VARIANT, ctx)).toMatch(
      /Generate about \d+ words of text\. It begins .+\./,
    );
  });
});

describe("gallery seed term", () => {
  it("omits the slot entirely when the gallery has no terms", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, ctx);
    expect(prompt).not.toMatch(/has to do with/i);
    // No gap left where the omitted sentence would have been.
    expect(prompt).not.toMatch(/ {2,}/);
  });

  it("states the term loosely, as a fact about the text", () => {
    const prompt = buildPrompt(DEFAULT_PROMPT_VARIANT, { ...ctx, seedTerm: "oak bark" });
    expect(prompt).toContain("Something in it has to do with oak bark.");
    expect(prompt).not.toMatch(/do not write|avoid|you must/i);
    // Loose on purpose — naming the term as *the subject* turns the text into
    // an encyclopedia entry about it.
    expect(prompt).not.toMatch(/the subject of this|this text is about/i);
  });
});
