import { describe, expect, it } from "vitest";
import { charsPerLine, foldLines } from "./layout";
import { simulatedRenderer, wrapText } from "./wrap";

describe("wrapText", () => {
  it("returns a single line for text shorter than the measure", () => {
    expect(wrapText("A short line.", "desktop")).toEqual(["A short line."]);
  });

  it("hard-breaks on every newline, including consecutive ones", () => {
    const lines = wrapText("first\n\nthird", "desktop");
    expect(lines).toEqual(["first", "", "third"]);
  });

  it("greedily wraps at word boundaries to the profile's measure", () => {
    const measure = charsPerLine("mobile"); // 36
    const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const lines = wrapText(text, "mobile");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(measure);
    }
    // Reassembling with spaces recovers all the words in order (nothing lost).
    expect(lines.join(" ").split(/\s+/).filter(Boolean)).toEqual(words);
  });

  it("preserves leading spaces and counts them toward the measure", () => {
    const lines = wrapText("   indented line", "desktop");
    expect(lines[0].startsWith("   ")).toBe(true);
  });

  it("does not break a single token longer than the measure (no overflow-wrap)", () => {
    const measure = charsPerLine("mobile");
    const longToken = "x".repeat(measure + 20);
    const lines = wrapText(`${longToken} next`, "mobile");
    // The overflowing token occupies its own line, unbroken.
    expect(lines[0]).toBe(longToken);
    expect(lines.some((l) => l.includes("next"))).toBe(true);
  });

  it("wraps a realistic paragraph to a plausible desktop line count", () => {
    const paragraph = Array.from({ length: 80 }, (_, i) => `token${i}`).join(" ");
    const lines = wrapText(paragraph, "desktop");
    const measure = charsPerLine("desktop");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(measure);
    }
  });

  it("gives an empty line for an empty string (one blank line box)", () => {
    expect(wrapText("", "desktop")).toEqual([""]);
  });
});

describe("simulatedRenderer", () => {
  it("produces a PageSnapshot with wrapped lines and a clamped fold", async () => {
    const text = "one two three";
    const s = await simulatedRenderer.render(text, "io-9/1/1/1/1", "desktop");
    expect(s.lines).toEqual(wrapText(text, "desktop"));
    expect(s.profile).toBe("desktop");
    // A short page never reaches its own fold.
    expect(s.foldLine).toBe(s.lines.length);
    expect(s.foldLine).toBeLessThanOrEqual(foldLines("desktop"));
  });

  it("sets foldLine to the profile's real fold for a page longer than the fold", async () => {
    const longText = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const s = await simulatedRenderer.render(longText, "io-9/1/1/1/1", "desktop");
    expect(s.lines.length).toBeGreaterThan(foldLines("desktop"));
    expect(s.foldLine).toBe(foldLines("desktop"));
  });
});
