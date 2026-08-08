import { describe, expect, it } from "vitest";
import { charsPerLine, foldLines, LANDING_LINES, VIEWPORT_PROFILES } from "./layout";

describe("layout constants", () => {
  it("derives desktop chars-per-line from max-w-2xl content width", () => {
    // 672 (max-w-2xl) - 64 (p-8 * 2) = 608; 608 / 9 = 67.5 -> 67
    expect(charsPerLine("desktop")).toBe(67);
  });

  it("caps content width at max-w-2xl even on a wider laptop viewport", () => {
    expect(VIEWPORT_PROFILES.laptop.contentWidth).toBe(VIEWPORT_PROFILES.desktop.contentWidth);
    expect(charsPerLine("laptop")).toBe(charsPerLine("desktop"));
  });

  it("derives a narrower mobile measure from the actual viewport width", () => {
    // 390 - 64 = 326; 326 / 9 = 36.2 -> 36
    expect(charsPerLine("mobile")).toBe(36);
  });

  it("derives desktop fold lines from viewport height minus article offset", () => {
    // (900 - 84) / 36 = 22.67 -> 22
    expect(foldLines("desktop")).toBe(22);
  });

  it("derives a shorter laptop fold", () => {
    // (800 - 84) / 36 = 19.9 -> 19
    expect(foldLines("laptop")).toBe(19);
  });

  it("accounts for the two-row mobile header when computing the fold", () => {
    // (745 - 104) / 36 = 17.8 -> 17
    expect(foldLines("mobile")).toBe(17);
  });

  it("mobile fold sits below desktop/laptop fold, both in lines and measure", () => {
    expect(foldLines("mobile")).toBeLessThan(foldLines("laptop"));
    expect(charsPerLine("mobile")).toBeLessThan(charsPerLine("desktop"));
  });

  it("defaults the landing window to 3 lines", () => {
    expect(LANDING_LINES).toBe(3);
  });
});
