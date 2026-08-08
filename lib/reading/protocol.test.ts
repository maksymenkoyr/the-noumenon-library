import { describe, expect, it } from "vitest";
import type { StageWindow } from "./stages";
import {
  buildProbePrompt,
  buildStagePrompt,
  buildVerdictSystemPrompt,
  END_FIELDS,
  fieldsFor,
  isAbstain,
  LANDING_FIELDS,
  parseStageReply,
  PROBE_FIELDS,
  RECALL_FIELDS,
  SCREEN_FIELDS,
} from "./protocol";

function flatten(parts: ReturnType<typeof buildStagePrompt>): string {
  return parts.map((p) => p.text).join("\n");
}

describe("fieldsFor", () => {
  it("maps each stage id to its field set", () => {
    expect(fieldsFor("landing")).toBe(LANDING_FIELDS);
    expect(fieldsFor("screen-1")).toBe(SCREEN_FIELDS);
    expect(fieldsFor("screen-2")).toBe(SCREEN_FIELDS);
    expect(fieldsFor("end")).toBe(END_FIELDS);
    expect(fieldsFor("recall")).toBe(RECALL_FIELDS);
    expect(fieldsFor("probe")).toBe(PROBE_FIELDS);
  });
});

describe("buildStagePrompt", () => {
  const lines = ["The kettle had been whistling", "for some time before she noticed."];

  it("shows the visible text and asks for landing fields", () => {
    const window: StageWindow = { id: "landing", kind: "reveal", upToLine: 1, reachesEnd: false };
    const out = flatten(buildStagePrompt(window, lines));
    expect(out).toContain("The kettle had been whistling");
    expect(out).toContain("CAUGHT:");
    expect(out).toContain("NEXT:");
    expect(out).not.toContain("she noticed"); // not yet revealed
  });

  it("includes the peripheral note about remaining text", () => {
    const window: StageWindow = { id: "landing", kind: "reveal", upToLine: 1, reachesEnd: false };
    const out = flatten(buildStagePrompt(window, lines));
    expect(out).toContain("continues for about");
  });

  it("says the text ends here once the window reaches the end", () => {
    const window: StageWindow = { id: "end", kind: "reveal", upToLine: 2, reachesEnd: true };
    const out = flatten(buildStagePrompt(window, lines));
    expect(out).toContain("The text ends here.");
    expect(out).toContain("DRIFT:");
    expect(out).toContain("END:");
  });

  it("asks screen-family fields for a screen-k window", () => {
    const window: StageWindow = { id: "screen-1", kind: "reveal", upToLine: 1, reachesEnd: false };
    const out = flatten(buildStagePrompt(window, lines));
    expect(out).toContain("STOPPED:");
    expect(out).toContain("AT:");
  });

  it("shows no page text for the recall (blind) window", () => {
    const window: StageWindow = { id: "recall", kind: "blind", upToLine: 0, reachesEnd: true };
    const out = flatten(buildStagePrompt(window, lines));
    expect(out).not.toContain("kettle");
    expect(out).toContain("IMAGE:");
    expect(out).toContain("The tab is closed");
  });
});

describe("buildProbePrompt", () => {
  it("labels the four options A through D", () => {
    const options = ["line one", "line two", "line three", "line four"] as const;
    const out = flatten(buildProbePrompt(options));
    expect(out).toContain("A) line one");
    expect(out).toContain("B) line two");
    expect(out).toContain("C) line three");
    expect(out).toContain("D) line four");
    expect(out).toContain("PICK:");
    expect(out).toContain("SURE:");
  });
});

describe("buildVerdictSystemPrompt", () => {
  it("states no base rate by default", () => {
    const prompt = buildVerdictSystemPrompt();
    expect(prompt.toLowerCase()).not.toContain("historically");
    expect(prompt).toContain("VERDICT:");
  });
});

describe("parseStageReply", () => {
  it("extracts a matching field, trimmed", () => {
    const reply = parseStageReply("CAUGHT: the kettle was whistling", ["CAUGHT"]);
    expect(reply.CAUGHT).toBe("the kettle was whistling");
  });

  it("treats NOTHING (any case) as null", () => {
    const reply = parseStageReply("CAUGHT: nothing", ["CAUGHT"]);
    expect(reply.CAUGHT).toBeNull();
  });

  it("treats an unmatched field as null", () => {
    const reply = parseStageReply("GUESS: a memoir", ["CAUGHT", "GUESS"]);
    expect(reply.CAUGHT).toBeNull();
    expect(reply.GUESS).toBe("a memoir");
  });

  it("strips surrounding quote marks", () => {
    const reply = parseStageReply('BACK: "the whistling kettle"', ["BACK"]);
    expect(reply.BACK).toBe("the whistling kettle");
  });

  it("parses multiple labeled lines out of one multi-line reply", () => {
    const raw = ["CAUGHT: the kettle", "GUESS: a memoir", "PULL: mild curiosity", "NEXT: CONTINUE"].join(
      "\n",
    );
    const reply = parseStageReply(raw, LANDING_FIELDS);
    expect(reply).toEqual({
      CAUGHT: "the kettle",
      GUESS: "a memoir",
      PULL: "mild curiosity",
      NEXT: "CONTINUE",
    });
  });

  it("is tolerant of stray prose around the labeled lines", () => {
    const raw = "Sure, here goes.\nCAUGHT: the kettle\nHope that helps!";
    const reply = parseStageReply(raw, ["CAUGHT"]);
    expect(reply.CAUGHT).toBe("the kettle");
  });
});

describe("isAbstain", () => {
  it("is true when every field is null", () => {
    expect(isAbstain({ CAUGHT: null, GUESS: null }, ["CAUGHT", "GUESS"])).toBe(true);
  });

  it("is false when any field has a value", () => {
    expect(isAbstain({ CAUGHT: "x", GUESS: null }, ["CAUGHT", "GUESS"])).toBe(false);
  });
});
