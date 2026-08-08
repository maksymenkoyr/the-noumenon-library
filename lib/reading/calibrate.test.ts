import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfusionMatrix, parseWanderEval } from "./calibrate";

describe("parseWanderEval", () => {
  it("extracts address and mark from bold-pause and plain-hollow headings", () => {
    const md = [
      "## 1. `kx3082547h28/2/3/31/363` — **`[pause]`**",
      "",
      "some prose",
      "",
      "## 2. `n476s1qv/2/4/15/10` — `[hollow]`",
    ].join("\n");
    expect(parseWanderEval(md)).toEqual([
      { address: "kx3082547h28/2/3/31/363", human: "pause" },
      { address: "n476s1qv/2/4/15/10", human: "hollow" },
    ]);
  });

  it("ignores non-heading lines that mention pause or hollow", () => {
    const md = "This page is a near-miss, not quite a pause, arguably hollow in the middle.";
    expect(parseWanderEval(md)).toEqual([]);
  });

  it("parses the real hand-scored eval file (12 scorable of 14 pages)", () => {
    const path = new URL("../../wander-eval-2026-07-31-base-v1.md", import.meta.url);
    const markdown = readFileSync(path, "utf8");
    const marks = parseWanderEval(markdown);
    expect(marks).toHaveLength(12);
    expect(marks.filter((m) => m.human === "pause")).toHaveLength(7);
    expect(marks.filter((m) => m.human === "hollow")).toHaveLength(5);
  });
});

describe("buildConfusionMatrix", () => {
  const marks = [
    { address: "a", human: "pause" as const },
    { address: "b", human: "pause" as const },
    { address: "c", human: "hollow" as const },
    { address: "d", human: "hollow" as const },
  ];

  it("counts true/false positives and negatives against a perfectly matching run", () => {
    const verdicts = new Map<string, "pause" | "hollow" | "bounce">([
      ["a", "pause"],
      ["b", "pause"],
      ["c", "hollow"],
      ["d", "hollow"],
    ]);
    const result = buildConfusionMatrix(marks, verdicts);
    expect(result).toMatchObject({
      n: 4,
      matched: 4,
      truePositive: 2,
      falseNegative: 0,
      falsePositive: 0,
      trueNegative: 2,
      agreementRate: 1,
    });
  });

  it("counts a run that disagrees on everything", () => {
    const verdicts = new Map<string, "pause" | "hollow" | "bounce">([
      ["a", "hollow"],
      ["b", "hollow"],
      ["c", "pause"],
      ["d", "pause"],
    ]);
    const result = buildConfusionMatrix(marks, verdicts);
    expect(result).toMatchObject({
      truePositive: 0,
      falseNegative: 2,
      falsePositive: 2,
      trueNegative: 0,
      agreementRate: 0,
    });
  });

  it("treats a bounce verdict as not-pause", () => {
    const verdicts = new Map<string, "pause" | "hollow" | "bounce">([["a", "bounce"]]);
    const result = buildConfusionMatrix([{ address: "a", human: "pause" }], verdicts);
    expect(result.falseNegative).toBe(1);
    expect(result.truePositive).toBe(0);
  });

  it("lists human-marked addresses this run's corpus never touched", () => {
    const verdicts = new Map<string, "pause" | "hollow" | "bounce">([["a", "pause"]]);
    const result = buildConfusionMatrix(marks, verdicts);
    expect(result.missingFromRun.sort()).toEqual(["b", "c", "d"]);
    expect(result.matched).toBe(1);
  });

  it("has agreementRate 0 (not NaN) when nothing matched", () => {
    const result = buildConfusionMatrix(marks, new Map());
    expect(result.agreementRate).toBe(0);
    expect(result.matched).toBe(0);
  });
});
