/**
 * Calibration against an existing hand-scored wander evaluation
 * (wander-eval-2026-07-31-base-v1.md is the only one that exists today: 14
 * pages, 12 scorable, 7 pause / 5 hollow). This is the harness's only
 * connection to actual human judgment — everything else it produces is
 * unvalidated until run through this.
 *
 * The comparison is deliberately reduced to the 2x2 that matches the actual
 * success bar: pause vs not-pause. A harness "bounce" collapses into
 * "not-pause" for this comparison, since the human marking scheme here has
 * no separate bounce category.
 */

export interface CalibrationMark {
  address: string;
  human: "pause" | "hollow";
}

// Matches headings like:
//   ## 1. `kx3082547h28/2/3/31/363` — **`[pause]`**
//   ## 3. `n476s1qv/2/4/15/10` — `[hollow]`
// i.e. optional bold around the bracketed mark.
const HEADING_RE = /^##\s+\d+\.\s+`([^`]+)`\s+—\s+\*{0,2}`\[(pause|hollow)\]`\*{0,2}/gim;

/** Extract every `## N. \`address\` — [pause|hollow]` heading from a
 * hand-scored wander-eval Markdown file. Ignores anything else in the file
 * (prose, tallies, per-page detail) — headings are the only load-bearing
 * structure here. */
export function parseWanderEval(markdown: string): CalibrationMark[] {
  const marks: CalibrationMark[] = [];
  for (const match of markdown.matchAll(HEADING_RE)) {
    marks.push({ address: match[1], human: match[2].toLowerCase() as "pause" | "hollow" });
  }
  return marks;
}

export interface CalibrationResult {
  n: number; // human marks found in the comparison file
  matched: number; // of those, how many addresses this run's corpus also covers
  truePositive: number;
  falseNegative: number;
  falsePositive: number;
  trueNegative: number;
  agreementRate: number; // (TP+TN) / matched, or 0 if matched is 0
  missingFromRun: string[]; // human-marked addresses this run never touched
}

/**
 * Build the 2x2 confusion matrix between human marks and this run's rule
 * verdicts. `verdictByAddress` should hold the *rule* verdict (not the model
 * verdict) for every sample page in the run — the rule verdict is the
 * auditable, primary one.
 */
export function buildConfusionMatrix(
  marks: readonly CalibrationMark[],
  verdictByAddress: ReadonlyMap<string, "pause" | "hollow" | "bounce">,
): CalibrationResult {
  let truePositive = 0;
  let falseNegative = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  const missingFromRun: string[] = [];

  for (const mark of marks) {
    const verdict = verdictByAddress.get(mark.address);
    if (verdict == null) {
      missingFromRun.push(mark.address);
      continue;
    }
    const modelPause = verdict === "pause";
    if (mark.human === "pause" && modelPause) truePositive++;
    else if (mark.human === "pause" && !modelPause) falseNegative++;
    else if (mark.human === "hollow" && modelPause) falsePositive++;
    else trueNegative++;
  }

  const matched = truePositive + falseNegative + falsePositive + trueNegative;
  const agreementRate = matched > 0 ? (truePositive + trueNegative) / matched : 0;

  return {
    n: marks.length,
    matched,
    truePositive,
    falseNegative,
    falsePositive,
    trueNegative,
    agreementRate,
    missingFromRun,
  };
}
