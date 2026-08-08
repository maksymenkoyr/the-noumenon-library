import { describe, expect, it } from "vitest";
import type { StageId } from "./stages";
import type { PageRun, PageRunMeta } from "./report";
import { aggregate, renderReport } from "./report";
import type { ReadingTrace, StageResult } from "./verdict";
import type { StageReply } from "./protocol";

function stage(
  id: StageId,
  kind: "reveal" | "blind",
  upToLine: number,
  reachesEnd: boolean,
  reply: StageReply,
): StageResult {
  return {
    window: { id, kind, upToLine, reachesEnd },
    reply,
    raw: "",
    abstained: Object.values(reply).every((v) => v == null),
  };
}

const PAGE_LINES = ["The kettle had been whistling for some time.", "She turned it off."];

function pausingTrace(readerModel = "z-ai/glm-5.2"): ReadingTrace {
  return {
    address: "io-9/1/1/1/1",
    protocolVersion: "reader-v1",
    readerModel,
    temperature: 0.7,
    stages: [
      stage("landing", "reveal", 1, false, { CAUGHT: "The kettle had been whistling", NEXT: "CONTINUE" }),
      stage("end", "reveal", 2, true, { END: "trailed off" }),
      stage("recall", "blind", 0, true, { IMAGE: "steam from a kettle", LINE: null, FEEL: "quiet" }),
    ],
    modelVerdict: { verdict: "pause", evidence: "recall IMAGE survived", confidence: "high", raw: "" },
  };
}

function hollowTrace(readerModel = "z-ai/glm-5.2"): ReadingTrace {
  return {
    address: "io-9/1/1/1/2",
    protocolVersion: "reader-v1",
    readerModel,
    temperature: 0.7,
    stages: [
      stage("landing", "reveal", 1, false, { CAUGHT: "The kettle had been whistling", NEXT: "CONTINUE" }),
      stage("end", "reveal", 2, true, { END: "trailed off" }),
      stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
    ],
    modelVerdict: { verdict: "hollow", evidence: "nothing survived recall", confidence: "high", raw: "" },
  };
}

function bounceTrace(): ReadingTrace {
  return {
    address: "io-9/1/1/1/3",
    protocolVersion: "reader-v1",
    readerModel: "z-ai/glm-5.2",
    temperature: 0.7,
    stages: [
      stage("landing", "reveal", 1, false, { CAUGHT: null, NEXT: "STOP" }),
      stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
    ],
  };
}

function unreliableTrace(): ReadingTrace {
  return {
    address: "io-9/1/1/1/4",
    protocolVersion: "reader-v1",
    readerModel: "z-ai/glm-5.2",
    temperature: 0.7,
    stages: [
      // Fabricated quote — not present anywhere in PAGE_LINES.
      stage("landing", "reveal", 1, false, { CAUGHT: "a sentence never on this page", NEXT: "CONTINUE" }),
      stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
    ],
  };
}

function erroredTrace(): ReadingTrace {
  return {
    address: "io-9/1/1/1/5",
    protocolVersion: "reader-v1",
    readerModel: "z-ai/glm-5.2",
    temperature: 0.7,
    stages: [],
    error: "provider returned 500",
  };
}

function run(meta: Partial<PageRunMeta> & Pick<PageRunMeta, "address" | "kind">, trace: ReadingTrace): PageRun {
  return { meta: { ...meta }, lines: PAGE_LINES, foldLine: PAGE_LINES.length, trace };
}

describe("aggregate", () => {
  it("tallies pause/hollow/bounce across sample pages", () => {
    const runs = [
      run({ address: "a", kind: "sample", model: "z-ai/glm-5.2" }, pausingTrace()),
      run({ address: "b", kind: "sample", model: "z-ai/glm-5.2" }, hollowTrace()),
      run({ address: "c", kind: "sample", model: "z-ai/glm-5.2" }, bounceTrace()),
    ];
    const result = aggregate(runs);
    expect(result.tally).toMatchObject({ scored: 3, pause: 1, hollow: 1, bounce: 1 });
  });

  it("excludes a quote-integrity failure from the scored tally but counts it as unreliable", () => {
    const runs = [run({ address: "d", kind: "sample" }, unreliableTrace())];
    const result = aggregate(runs);
    expect(result.tally.scored).toBe(0);
    expect(result.tally.unreliable).toBe(1);
  });

  it("counts an errored trace separately from unreliable or scored", () => {
    const runs = [run({ address: "e", kind: "sample" }, erroredTrace())];
    const result = aggregate(runs);
    expect(result.tally.errored).toBe(1);
    expect(result.tally.scored).toBe(0);
    expect(result.tally.unreliable).toBe(0);
  });

  it("flags a control that scores pause as a control failure", () => {
    const runs = [
      run({ address: "control-1", kind: "control-bland" }, pausingTrace()),
      run({ address: "sample-1", kind: "sample", model: "z-ai/glm-5.2" }, hollowTrace()),
    ];
    const result = aggregate(runs);
    expect(result.controlFailures).toHaveLength(1);
    expect(result.controlFailures[0].run.meta.address).toBe("control-1");
    // Controls never enter the sample tally.
    expect(result.tally.scored).toBe(1);
  });

  it("does not flag a control that scores hollow", () => {
    const runs = [run({ address: "control-1", kind: "control-shuffled" }, hollowTrace())];
    const result = aggregate(runs);
    expect(result.controlFailures).toHaveLength(0);
  });

  it("detects a reader/generator family collision", () => {
    const runs = [run({ address: "a", kind: "sample", model: "anthropic/claude-haiku-4.5" }, pausingTrace("anthropic/claude-sonnet-5"))];
    expect(aggregate(runs).familyCollision).toBe(true);
  });

  it("does not flag a collision across different vendor families", () => {
    const runs = [run({ address: "a", kind: "sample", model: "deepseek/deepseek-v4-flash" }, pausingTrace("anthropic/claude-sonnet-5"))];
    expect(aggregate(runs).familyCollision).toBe(false);
  });

  it("collects pages where the rule verdict and the model verdict disagree", () => {
    const disagreeing = pausingTrace();
    disagreeing.modelVerdict = { verdict: "hollow", evidence: "x", confidence: "low", raw: "" };
    const runs = [run({ address: "a", kind: "sample", model: "z-ai/glm-5.2" }, disagreeing)];
    const result = aggregate(runs);
    expect(result.disagreements).toHaveLength(1);
  });

  it("does not flag a page as disagreeing when there is no model verdict at all", () => {
    const noVerdict = pausingTrace();
    delete noVerdict.modelVerdict;
    const runs = [run({ address: "a", kind: "sample", model: "z-ai/glm-5.2" }, noVerdict)];
    expect(aggregate(runs).disagreements).toHaveLength(0);
  });

  it("breaks tallies down by generation model and prompt variant", () => {
    const runs = [
      run({ address: "a", kind: "sample", model: "model-a", promptVariant: "base-v1+no-library" }, pausingTrace()),
      run({ address: "b", kind: "sample", model: "model-b", promptVariant: "base-v1" }, hollowTrace()),
    ];
    const result = aggregate(runs);
    expect(result.byModel.get("model-a")?.pause).toBe(1);
    expect(result.byModel.get("model-b")?.hollow).toBe(1);
    expect(result.byVariant.get("base-v1+no-library")?.pause).toBe(1);
  });

  it("computes landing-continue and recall-survival rates", () => {
    const runs = [
      run({ address: "a", kind: "sample", model: "m" }, pausingTrace()), // continues, survives
      run({ address: "b", kind: "sample", model: "m" }, bounceTrace()), // stops, no survival
    ];
    const result = aggregate(runs);
    expect(result.tally.landingContinueRate).toBeCloseTo(0.5);
    expect(result.tally.recallSurvivalRate).toBeCloseTo(0.5);
  });
});

describe("renderReport", () => {
  const baseConfig = {
    timestamp: "2026-08-08T00:00:00.000Z",
    corpusDescription: "status='ok', seed=1, limit=2",
    viewportProfile: "desktop" as const,
    charsPerLine: 67,
    foldLines: 22,
    landingLines: 3,
    protocolVersion: "reader-v1",
    readerModel: "z-ai/glm-5.2",
    readerTemperature: 0.7,
    verdictTemperature: 0,
  };

  it("prints the control-failure banner and suppresses trust in the tally when a control paused", () => {
    const runs = [run({ address: "control-1", kind: "control-bland" }, pausingTrace())];
    const result = aggregate(runs);
    const report = renderReport(baseConfig, result);
    expect(report).toContain("NOT TRUSTWORTHY");
  });

  it("omits the banner on a clean run", () => {
    const runs = [run({ address: "a", kind: "sample", model: "m" }, hollowTrace())];
    const result = aggregate(runs);
    const report = renderReport(baseConfig, result);
    expect(report).not.toContain("NOT TRUSTWORTHY");
  });

  it("includes the protocol version and reader model in the header", () => {
    const result = aggregate([]);
    const report = renderReport(baseConfig, result);
    expect(report).toContain("reader-v1");
    expect(report).toContain("z-ai/glm-5.2");
    expect(report).toContain("must not be compared");
  });

  it("prints a human-scoring slot per page, matching the wander vocabulary", () => {
    const runs = [run({ address: "a", kind: "sample", model: "m" }, pausingTrace())];
    const result = aggregate(runs);
    const report = renderReport(baseConfig, result);
    expect(report).toContain("human: `[ ]`");
    expect(report).toContain("`a`");
  });

  it("lists disagreements when the rule and model verdicts differ", () => {
    const disagreeing = pausingTrace();
    disagreeing.modelVerdict = { verdict: "hollow", evidence: "x", confidence: "low", raw: "" };
    const runs = [run({ address: "a", kind: "sample", model: "m" }, disagreeing)];
    const result = aggregate(runs);
    const report = renderReport(baseConfig, result);
    expect(report).toContain("rule: pause, model: hollow");
  });
});
