import { describe, expect, it } from "vitest";
import type { StageId } from "./stages";
import type { ReadingTrace, StageResult } from "./verdict";
import {
  detectEcho,
  hasQuoteFailure,
  normalizeQuote,
  parseModelVerdict,
  ruleVerdict,
  verifyQuotes,
} from "./verdict";
import type { StageReply } from "./protocol";

const FULL_LINES = [
  "The kettle had been whistling for some time before she noticed it,",
  "and by then the sound had become part of the room.",
  "She turned it off and stood in the sudden quiet.",
];

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

function trace(stages: StageResult[], overrides: Partial<ReadingTrace> = {}): ReadingTrace {
  return {
    address: "io-9/1/1/1/1",
    protocolVersion: "reader-v1",
    readerModel: "test-model",
    temperature: 0.7,
    stages,
    ...overrides,
  };
}

describe("normalizeQuote", () => {
  it("lowercases, strips quote marks, and collapses whitespace", () => {
    expect(normalizeQuote('  "The   Kettle"  ')).toBe("the kettle");
  });
});

describe("verifyQuotes", () => {
  it("passes a quote that appears within the stage's revealed window", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { CAUGHT: "The kettle had been whistling", NEXT: "CONTINUE" }),
    ]);
    const checks = verifyQuotes(t, FULL_LINES);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ field: "CAUGHT", ok: true });
  });

  it("fails a fabricated quote not present in what was seen", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { CAUGHT: "a sentence that was never on the page" }),
    ]);
    const checks = verifyQuotes(t, FULL_LINES);
    expect(checks[0].ok).toBe(false);
  });

  it("fails a quote that only appears later in the page, beyond the window shown so far", () => {
    // "sudden quiet" is on line 3, but this landing window only reveals line 1.
    const t = trace([stage("landing", "reveal", 1, false, { CAUGHT: "sudden quiet" })]);
    const checks = verifyQuotes(t, FULL_LINES);
    expect(checks[0].ok).toBe(false);
  });

  it("skips NOTHING/null fields entirely", () => {
    const t = trace([stage("landing", "reveal", 1, false, { CAUGHT: null })]);
    expect(verifyQuotes(t, FULL_LINES)).toHaveLength(0);
  });

  it("checks recall's LINE against the whole page even though its window is blind", () => {
    const t = trace([stage("recall", "blind", 0, true, { LINE: "sudden quiet" })]);
    const checks = verifyQuotes(t, FULL_LINES);
    expect(checks[0]).toMatchObject({ field: "LINE", ok: true });
  });

  it("still fails a recall LINE that was never on the page at all", () => {
    const t = trace([stage("recall", "blind", 0, true, { LINE: "the moon fell into the sea" })]);
    expect(verifyQuotes(t, FULL_LINES)[0].ok).toBe(false);
  });
});

describe("hasQuoteFailure", () => {
  it("is true when any check failed", () => {
    expect(hasQuoteFailure([{ stageId: "landing", field: "CAUGHT", value: "x", ok: false }])).toBe(true);
  });
  it("is false for an all-passing or empty check list", () => {
    expect(hasQuoteFailure([{ stageId: "landing", field: "CAUGHT", value: "x", ok: true }])).toBe(false);
    expect(hasQuoteFailure([])).toBe(false);
  });
});

describe("detectEcho", () => {
  it("flags a recall LINE that just repeats an earlier stage's own quote", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { CAUGHT: "The kettle had been whistling" }),
      stage("recall", "blind", 0, true, { LINE: "the kettle had been whistling" }),
    ]);
    expect(detectEcho(t).LINE).toBe(true);
  });

  it("does not flag a recall value unrelated to anything said earlier", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { CAUGHT: "The kettle had been whistling" }),
      stage("recall", "blind", 0, true, { LINE: "she stood in the quiet" }),
    ]);
    expect(detectEcho(t).LINE).toBe(false);
  });

  it("returns no entries when there is no recall stage", () => {
    const t = trace([stage("landing", "reveal", 1, false, { CAUGHT: "x" })]);
    expect(detectEcho(t)).toEqual({});
  });
});

describe("ruleVerdict", () => {
  it("calls pause when something survives recall", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { NEXT: "CONTINUE" }),
      stage("recall", "blind", 0, true, { IMAGE: "steam rising off a kettle", LINE: null, FEEL: null }),
    ]);
    expect(ruleVerdict(t).verdict).toBe("pause");
    expect(ruleVerdict(t).survived).toBe(true);
  });

  it("calls pause when the recognition probe is answered correctly, even with no free recall", () => {
    const t = trace(
      [
        stage("landing", "reveal", 1, false, { NEXT: "CONTINUE" }),
        stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
      ],
      { probe: { options: ["a", "b", "c", "d"], correctIndex: 2, usable: true, picked: "C" } },
    );
    const v = ruleVerdict(t);
    expect(v.probeCorrect).toBe(true);
    expect(v.verdict).toBe("pause");
  });

  it("does NOT call pause on a BACK/HOLD regression alone, with nothing corroborating it", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { NEXT: "CONTINUE" }),
      stage("screen-1", "reveal", 5, false, { BACK: "she stood in the quiet", WHY: "HOLD", NEXT: "CONTINUE" }),
      stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
    ]);
    const v = ruleVerdict(t);
    expect(v.holdSignal).toBe(true);
    expect(v.survived).toBe(false);
    expect(v.probeCorrect).toBeNull();
    expect(v.verdict).not.toBe("pause");
  });

  it("marks corroborated when HOLD accompanies actual surviving recall", () => {
    const t = trace([
      stage("screen-1", "reveal", 5, false, { BACK: "x", WHY: "HOLD" }),
      stage("recall", "blind", 0, true, { IMAGE: "a kettle", LINE: null, FEEL: null }),
    ]);
    const v = ruleVerdict(t);
    expect(v.corroborated).toBe(true);
  });

  it("calls bounce when the reader stops at landing and nothing survives", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { NEXT: "STOP" }),
      stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
    ]);
    expect(ruleVerdict(t).verdict).toBe("bounce");
  });

  it("calls hollow for a completed, unremarkable read with no recall and no early stop", () => {
    const t = trace([
      stage("landing", "reveal", 1, false, { NEXT: "CONTINUE" }),
      stage("end", "reveal", 20, true, { END: "trailed off" }),
      stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
    ]);
    expect(ruleVerdict(t).verdict).toBe("hollow");
  });

  it("distinguishes CONFUSION from HOLD and never conflates the two", () => {
    const t = trace([
      stage("screen-1", "reveal", 5, false, { BACK: "x", WHY: "CONFUSION" }),
      stage("recall", "blind", 0, true, { IMAGE: null, LINE: null, FEEL: null }),
    ]);
    const v = ruleVerdict(t);
    expect(v.confusionSignal).toBe(true);
    expect(v.holdSignal).toBe(false);
  });
});

describe("parseModelVerdict", () => {
  it("parses a well-formed verdict reply", () => {
    const raw = "VERDICT: PAUSE\nEVIDENCE: recall LINE survived\nCONFIDENCE: HIGH";
    expect(parseModelVerdict(raw)).toMatchObject({
      verdict: "pause",
      evidence: "recall LINE survived",
      confidence: "high",
    });
  });

  it("is case-insensitive on the verdict word", () => {
    expect(parseModelVerdict("VERDICT: hollow").verdict).toBe("hollow");
  });

  it("abstains (null) on an unrecognized verdict word", () => {
    expect(parseModelVerdict("VERDICT: MAYBE").verdict).toBeNull();
  });

  it("abstains entirely on a reply with no labeled lines", () => {
    const parsed = parseModelVerdict("I'm not sure how to answer that.");
    expect(parsed.verdict).toBeNull();
    expect(parsed.confidence).toBeNull();
  });
});
