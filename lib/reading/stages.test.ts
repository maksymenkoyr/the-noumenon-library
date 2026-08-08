import { describe, expect, it } from "vitest";
import type { PageSnapshot } from "./layout";
import { peripheralNote, planStages, renderWindow } from "./stages";

/** Build a snapshot directly (no wrapping needed) for stage-plan tests. */
function snapshot(lineCount: number, foldLine: number): PageSnapshot {
  return {
    lines: Array.from({ length: lineCount }, (_, i) => `line ${i}`),
    foldLine,
    profile: "desktop",
  };
}

describe("planStages", () => {
  it("collapses to landing -> end when the whole page fits above the fold (desktop, ~20-line page)", () => {
    const s = snapshot(20, 22); // fold clamped to lines.length by the renderer in practice
    const windows = planStages(s);
    expect(windows.map((w) => w.id)).toEqual(["landing", "end", "recall", "probe"]);
    expect(windows[0]).toMatchObject({ upToLine: 3, reachesEnd: false });
    expect(windows[1]).toMatchObject({ upToLine: 20, reachesEnd: true });
  });

  it("expands to landing, two screens, and end on a short fold (mobile, ~67-line page)", () => {
    const s = snapshot(67, 17);
    const windows = planStages(s);
    expect(windows.map((w) => w.id)).toEqual([
      "landing",
      "screen-1",
      "screen-2",
      "end",
      "recall",
      "probe",
    ]);
    expect(windows[1]).toMatchObject({ upToLine: 17, reachesEnd: false });
    expect(windows[2]).toMatchObject({ upToLine: 34, reachesEnd: false });
    expect(windows[3]).toMatchObject({ upToLine: 67, reachesEnd: true });
  });

  it("never names the end-reaching window screen-k, even when it exactly hits a fold multiple", () => {
    // fold * 2 lands exactly on total: the window that reaches the end must
    // still be called "end", not "screen-2".
    const s = snapshot(34, 17);
    const windows = planStages(s);
    expect(windows.map((w) => w.id)).toEqual(["landing", "screen-1", "end", "recall", "probe"]);
    expect(windows[2]).toMatchObject({ upToLine: 34, reachesEnd: true });
  });

  it("skips all reveal windows but landing when the page is shorter than the landing window", () => {
    const s = snapshot(1, 22);
    const windows = planStages(s);
    expect(windows.map((w) => w.id)).toEqual(["landing", "recall", "probe"]);
    expect(windows[0]).toMatchObject({ upToLine: 1, reachesEnd: true });
  });

  it("handles a zero-line page without crashing", () => {
    const s = snapshot(0, 0);
    const windows = planStages(s);
    expect(windows.map((w) => w.id)).toEqual(["landing", "recall", "probe"]);
    expect(windows[0]).toMatchObject({ upToLine: 0, reachesEnd: true });
  });

  it("always appends exactly one recall and one probe window, both blind", () => {
    for (const [lines, fold] of [
      [20, 22],
      [67, 17],
      [1, 22],
      [0, 0],
    ] as const) {
      const windows = planStages(snapshot(lines, fold));
      const tail = windows.slice(-2);
      expect(tail.map((w) => w.id)).toEqual(["recall", "probe"]);
      for (const w of tail) {
        expect(w.kind).toBe("blind");
        expect(w.upToLine).toBe(0);
      }
    }
  });

  it("respects a smaller screen cap", () => {
    const s = snapshot(200, 17);
    const windows = planStages(s, 1);
    // landing, screen-1, end (forced after cap), recall, probe
    expect(windows.map((w) => w.id)).toEqual(["landing", "screen-1", "end", "recall", "probe"]);
  });
});

describe("renderWindow", () => {
  it("renders text up to a reveal window's upToLine", () => {
    const lines = ["a", "b", "c", "d"];
    const window = { id: "landing" as const, kind: "reveal" as const, upToLine: 2, reachesEnd: false };
    expect(renderWindow(lines, window)).toBe("a\nb");
  });

  it("renders nothing for a blind window", () => {
    const lines = ["a", "b", "c"];
    const window = { id: "recall" as const, kind: "blind" as const, upToLine: 0, reachesEnd: true };
    expect(renderWindow(lines, window)).toBe("");
  });
});

describe("peripheralNote", () => {
  it("reports remaining lines for a reveal window that hasn't reached the end", () => {
    const window = { id: "landing" as const, kind: "reveal" as const, upToLine: 3, reachesEnd: false };
    expect(peripheralNote(20, window)).toBe("(Below what you can see, the text continues for about 17 more lines.)");
  });

  it("uses singular phrasing for exactly one remaining line", () => {
    const window = { id: "screen-1" as const, kind: "reveal" as const, upToLine: 19, reachesEnd: false };
    expect(peripheralNote(20, window)).toBe("(Below what you can see, the text continues for about 1 more line.)");
  });

  it("says the text ends here once a window reaches the end", () => {
    const window = { id: "end" as const, kind: "reveal" as const, upToLine: 20, reachesEnd: true };
    expect(peripheralNote(20, window)).toBe("(The text ends here.)");
  });

  it("is empty for a blind window", () => {
    const window = { id: "recall" as const, kind: "blind" as const, upToLine: 0, reachesEnd: true };
    expect(peripheralNote(20, window)).toBe("");
  });
});
