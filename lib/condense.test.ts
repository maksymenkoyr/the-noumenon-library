import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();
vi.mock("./openrouter", () => ({
  getOpenRouter: () => ({ chat: { completions: { create: createMock } } }),
}));

import { assembleCondensed, condensePage, extractSeams } from "./condense";

/** Build a fake completion whose content is `content`. */
function reply(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { total_tokens: 50 },
  };
}

/** N distinct filler sentences of ~6 words each. */
function fillerSentences(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `Filler sentence number ${i} carries ordinary words onward.`,
  ).join(" ");
}

beforeEach(() => {
  createMock.mockReset();
});

describe("extractSeams", () => {
  it("keeps the first and last sentences verbatim as head and tail", () => {
    const head = "The ship left harbor at dawn.";
    const tail = "No one watched it go.";
    const { head: h, middle, tail: t } = extractSeams(
      `${head} ${fillerSentences(10)} ${tail}`,
    );
    expect(h.startsWith(head)).toBe(true);
    expect(t.endsWith(tail)).toBe(true);
    expect(middle).toContain("Filler sentence number 3");
    expect(middle).not.toContain("The ship left harbor");
    expect(middle).not.toContain("No one watched it go");
  });

  it("returns short text whole as head — its own condensation", () => {
    expect(extractSeams("One lone sentence.")).toEqual({
      head: "One lone sentence.",
      middle: "",
      tail: "",
    });
    expect(extractSeams("First. Second. Third.")).toEqual({
      head: "First. Second. Third.",
      middle: "",
      tail: "",
    });
  });

  it("falls back to word windows for punctuation-less text", () => {
    const all = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const { head, middle, tail } = extractSeams(all);
    expect(head.split(" ")).toHaveLength(40);
    expect(head.startsWith("word0")).toBe(true);
    expect(tail.split(" ")).toHaveLength(40);
    expect(tail.endsWith("word119")).toBe(true);
    expect(middle.startsWith("word40")).toBe(true);
  });

  it("caps seams at two sentences within the word budget", () => {
    const text = `Short one. Short two. ${fillerSentences(10)} Short nine. Short ten.`;
    const { head, tail } = extractSeams(text);
    expect(head).toBe("Short one. Short two.");
    expect(tail).toBe("Short nine. Short ten.");
  });
});

describe("assembleCondensed", () => {
  it("joins head, summary, and tail with ellipsis markers", () => {
    expect(assembleCondensed("Head.", "The middle, condensed.", "Tail.")).toBe(
      "Head.\n…\nThe middle, condensed.\n…\nTail.",
    );
  });

  it("keeps one ellipsis when the middle is empty (extractive degrade)", () => {
    expect(assembleCondensed("Head.", "", "Tail.")).toBe("Head.\n…\nTail.");
  });
});

describe("condensePage", () => {
  const opening = "The ship left harbor at dawn.";
  const closing = "No one watched it go.";
  // ~120-word middle — comfortably over the 60-word threshold.
  const longPage = `${opening} ${fillerSentences(20)} ${closing}`;
  // The seams the extractor actually keeps (may span two sentences).
  const seams = extractSeams(longPage);

  it("returns short content verbatim without an LLM call", async () => {
    const short = "A brief page. Barely two sentences.";
    const { condensed, usage } = await condensePage(short);
    expect(condensed).toBe(short);
    expect(usage.tokens).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("summarizes the middle and keeps the seams verbatim", async () => {
    createMock.mockResolvedValue(reply("A ship sails; days pass."));
    const { condensed, usage } = await condensePage(longPage);
    expect(condensed).toBe(
      `${seams.head}\n…\nA ship sails; days pass.\n…\n${seams.tail}`,
    );
    expect(condensed.startsWith(opening)).toBe(true);
    expect(condensed.endsWith(closing)).toBe(true);
    expect(usage.tokens).toBe(50);
    expect(createMock).toHaveBeenCalledTimes(1);
    // The LLM only ever sees the middle, never the seams.
    const prompt = createMock.mock.calls[0][0].messages[0].content as string;
    expect(prompt).not.toContain(opening);
    expect(prompt).not.toContain(closing);
    expect(prompt).toContain("Filler sentence number 3");
  });

  it("degrades to extractive seams when the LLM call fails", async () => {
    createMock.mockRejectedValue(new Error("429 rate limited"));
    const { condensed } = await condensePage(longPage);
    expect(condensed).toBe(`${seams.head}\n…\n${seams.tail}`);
  });

  it("degrades to extractive seams on an empty reply", async () => {
    createMock.mockResolvedValue(reply(""));
    const { condensed } = await condensePage(longPage);
    expect(condensed).toBe(`${seams.head}\n…\n${seams.tail}`);
  });
});
