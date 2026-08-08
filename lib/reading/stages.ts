/**
 * The reading-stage plan: which slice of the page a simulated reader sees at
 * each step, computed from a rendered `PageSnapshot` (./layout.ts) rather than
 * fixed at some number of stages. See the plan's "Stage plan (computed, not
 * fixed)": a 400-word page fits entirely above a desktop fold, so the plan
 * collapses to `landing -> end`; the same page on `mobile` expands to four
 * reveal windows because the fold is much shorter.
 *
 * Stages beyond the reveal windows (`recall`, `probe`) carry no text at all —
 * the whole point of the recall stage is that the page is gone.
 */

import type { PageSnapshot } from "./layout.ts";
import { LANDING_LINES } from "./layout.ts";

export type StageId = "landing" | `screen-${number}` | "end" | "recall" | "probe";

export interface StageWindow {
  id: StageId;
  /** `reveal` windows show text up to `upToLine`; `blind` windows show none —
   * the page is out of context entirely (recall, probe). */
  kind: "reveal" | "blind";
  /** Exclusive end index into `snapshot.lines`. 0 for blind windows. */
  upToLine: number;
  /** True once this window has revealed the entire page. The window that
   * first reaches the end is always named "end", never "screen-k" — see
   * `planStages`. */
  reachesEnd: boolean;
}

/** At most this many fold-bounded "screen-k" windows before the remainder is
 * shown in one final "end" window — keeps a very long/narrow (mobile) page
 * from producing an unbounded number of reading stages. */
export const DEFAULT_SCREEN_CAP = 2;

/**
 * Compute the reveal windows for one page at one viewport, plus the two blind
 * stages that always run. Pure function of the snapshot — works identically
 * whether `snapshot` came from the simulated renderer or a future browser
 * renderer, since both produce the same `PageSnapshot` shape.
 */
export function planStages(
  snapshot: PageSnapshot,
  screenCap: number = DEFAULT_SCREEN_CAP,
): StageWindow[] {
  const total = snapshot.lines.length;
  const landingEnd = Math.min(LANDING_LINES, total);
  const windows: StageWindow[] = [
    { id: "landing", kind: "reveal", upToLine: landingEnd, reachesEnd: landingEnd === total },
  ];

  if (landingEnd < total) {
    const fold = Math.max(snapshot.foldLine, 1); // guard against a degenerate 0-line fold
    let cursor = landingEnd;
    for (let k = 1; k <= screenCap && cursor < total; k++) {
      const next = Math.min(fold * k, total);
      if (next <= cursor) continue; // fold shorter than what's already shown; skip a no-op window
      if (next === total) {
        windows.push({ id: "end", kind: "reveal", upToLine: next, reachesEnd: true });
        cursor = next;
        break;
      }
      windows.push({ id: `screen-${k}`, kind: "reveal", upToLine: next, reachesEnd: false });
      cursor = next;
    }
    // The screen-cap loop exhausted without reaching the end: show the rest
    // in one final window rather than truncating the page unread.
    if (cursor < total) {
      windows.push({ id: "end", kind: "reveal", upToLine: total, reachesEnd: true });
    }
  }

  windows.push({ id: "recall", kind: "blind", upToLine: 0, reachesEnd: true });
  windows.push({ id: "probe", kind: "blind", upToLine: 0, reachesEnd: true });
  return windows;
}

/** The text visible within one reveal window; "" for a blind window. */
export function renderWindow(lines: string[], window: StageWindow): string {
  if (window.kind === "blind") return "";
  return lines.slice(0, window.upToLine).join("\n");
}

/**
 * The one-sentence note about what's off-screen, appended to a reveal-stage
 * prompt (./protocol.ts) so the reader knows there's more (or that there
 * isn't) without being shown it — peripheral awareness, not vision.
 */
export function peripheralNote(totalLines: number, window: StageWindow): string {
  if (window.kind === "blind") return "";
  const remaining = totalLines - window.upToLine;
  if (remaining <= 0) return "(The text ends here.)";
  return `(Below what you can see, the text continues for about ${remaining} more line${remaining === 1 ? "" : "s"}.)`;
}
