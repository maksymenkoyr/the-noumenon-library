import { describe, expect, it } from "vitest";
import { ENDINGS, applyEnding, pickEnding } from "./pageCut";

/** `n` words of predictable, 4-letter filler — never a sentence boundary. */
const filler = (n: number) => Array.from({ length: n }, () => "word").join(" ");
const count = (s: string) => s.trim().split(/\s+/).length;

describe("applyEnding", () => {
  describe("cut-hard", () => {
    it("cuts to exactly the page size", () => {
      const r = applyEnding(filler(500), "cut-hard", 200);
      expect(r.words).toBe(200);
      expect(r.cut).toBe(true);
    });

    it("breaks mid-word when the final word invites it", () => {
      // midToken is derived from the final word's length rather than drawn, so
      // the same stored text always cuts the same way. "alpha" is 5 letters →
      // 5 % 5 === 0 → mid-word.
      const text = `${filler(9)} alpha ${filler(50)}`;
      const r = applyEnding(text, "cut-hard", 10);
      expect(r.text.endsWith("alp")).toBe(true);
      // The fragment still counts as the tenth word — the page is full.
      expect(r.words).toBe(10);
    });

    it("never breaks a word too short to leave a fragment", () => {
      // "word" is 4 letters → not a mid-word candidate, and even if it were,
      // a two-letter stub reads as corruption rather than a page break.
      const r = applyEnding(filler(50), "cut-hard", 10);
      expect(r.text.endsWith("word")).toBe(true);
    });
  });

  describe("cut-soft", () => {
    it("falls back to the last sentence boundary before the page ends", () => {
      // Sentence closes at word 18; the page would otherwise end at 25.
      const text = `${filler(17)} end. ${filler(60)}`;
      const r = applyEnding(text, "cut-soft", 25);
      expect(r.text.endsWith("end.")).toBe(true);
      expect(r.words).toBe(18);
      expect(r.cut).toBe(true);
    });

    it("accepts a boundary closed by a quote or bracket", () => {
      const text = `${filler(17)} home." ${filler(60)}`;
      expect(applyEnding(text, "cut-soft", 25).text.endsWith('home."')).toBe(true);
    });

    it("hard-cuts instead when the nearest boundary is too far back", () => {
      // A boundary 60 words back would leave a page two-thirds empty and call
      // it full. A jagged edge beats a dishonest one.
      const text = `${filler(9)} end. ${filler(200)}`;
      const r = applyEnding(text, "cut-soft", 70);
      expect(r.words).toBe(70);
      expect(r.text.endsWith("end.")).toBe(false);
    });
  });

  describe("complete", () => {
    it("leaves a finished text alone", () => {
      const text = `${filler(40)} done.`;
      const r = applyEnding(text, "complete", 200);
      expect(r.text).toBe(text);
      expect(r.cut).toBe(false);
    });

    it("still backstops a text that overruns the page", () => {
      // "Complete" is not a licence to render past the container.
      const r = applyEnding(`${filler(300)} end. ${filler(50)}`, "complete", 200);
      expect(r.words).toBeLessThanOrEqual(200);
      expect(r.cut).toBe(true);
    });
  });

  describe("every ending", () => {
    it("passes short text through untouched and reports no cut", () => {
      // The model came up short. Nothing to trim, and `cut: false` is the
      // signal that the whitespace on screen is a weak generation.
      for (const { id } of ENDINGS) {
        const r = applyEnding(filler(50), id, 200);
        expect(r.words).toBe(50);
        expect(r.cut).toBe(false);
      }
    });

    it("strips the narrator's ellipsis from both edges", () => {
      // The prompt asks for this too, but a cut can expose one the prompt
      // never saw, so it is enforced rather than hoped for.
      for (const { id } of ENDINGS) {
        const r = applyEnding(`… ${filler(20)} …`, id, 200);
        expect(r.text.startsWith("…")).toBe(false);
        expect(r.text.endsWith("…")).toBe(false);
        expect(applyEnding(`... ${filler(20)}...`, id, 200).text).not.toMatch(
          /^\.{2,}|\.{2,}$/,
        );
      }
    });

    it("strips a title the model gave itself", () => {
      // Four live pages in ten opened with a Markdown H1 — including
      // "# Mid-Paragraph Fragment", the model titling the page after its own
      // instruction. A page of a book has no heading.
      for (const title of ["# The Warehouse", "### Chapter One", "**The Kiln**"]) {
        const r = applyEnding(`${title}\n\n${filler(20)}`, "complete", 200);
        expect(r.text).toBe(filler(20));
      }
    });

    it("keeps a page that merely opens with a hash or an emphasis", () => {
      // "#3" is not a heading, and inline bold is not a title — the guard has
      // to be narrower than "starts with # or *".
      expect(applyEnding(`#3 ${filler(20)}`, "complete", 200).text).toMatch(/^#3 /);
      expect(applyEnding(`**bold** ${filler(20)}`, "complete", 200).text).toMatch(
        /^\*\*bold\*\* /,
      );
    });

    it("does not leave an opening quote dangling at the break", () => {
      const r = applyEnding(`${filler(9)} " ${filler(200)}`, "cut-hard", 11);
      expect(r.text.endsWith('"')).toBe(false);
    });

    it("is idempotent — re-cutting a stored page changes nothing", () => {
      for (const { id } of ENDINGS) {
        const once = applyEnding(filler(500), id, 200);
        expect(applyEnding(once.text, id, 200).text).toBe(once.text);
      }
    });

    it("reports the word count of the text it returns", () => {
      for (const { id } of ENDINGS) {
        const r = applyEnding(`${filler(300)} end. ${filler(80)}`, id, 200);
        expect(r.words).toBe(count(r.text));
      }
    });
  });
});

describe("pickEnding", () => {
  it("keeps the library 85% full pages", () => {
    const total = ENDINGS.reduce((sum, o) => sum + o.weight, 0);
    const complete = ENDINGS.find((o) => o.id === "complete")!;
    // `complete` is the only ending where the model picks its own stopping
    // point — and left to itself it writes the self-contained vignette the
    // entropy dials exist to push against. It stays the minority.
    expect(complete.weight / total).toBeCloseTo(0.15);
    expect(1 - complete.weight / total).toBeCloseTo(0.85);
  });

  it("draws every ending given enough samples, and is deterministic", () => {
    let seed = 1;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const drawn = new Set(Array.from({ length: 200 }, () => pickEnding(rng).id));
    expect(drawn.size).toBe(3);

    const fixed = () => 0.01;
    expect(pickEnding(fixed).id).toBe(pickEnding(fixed).id);
  });
});
