/**
 * The forced-choice recognition probe (plan §"The recognition probe" — the
 * sharpest instrument in the harness). After free recall, still with no
 * text, the reader picks this page's line out of four: itself plus three
 * decoys sampled from OTHER pages in the same run. Objective, 25% baseline,
 * immune to politeness — a reader that can't tell this page's sentence from
 * a sibling page's sentence *is* "coherent but hollow," operationalized.
 */

import type { Rng } from "./rng.ts";
import { pickOne, shuffle } from "./rng.ts";
import type { ProbeResult } from "./verdict.ts";

function normalizeForMatch(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

const UNUSABLE: ProbeResult = {
  options: ["", "", "", ""],
  correctIndex: 0,
  usable: false,
};

/**
 * Build one page's probe. `alreadyQuoted` is every verbatim fragment the
 * reader itself cited during the reading stages (CAUGHT/STOPPED/BACK/AT/DRIFT)
 * — the truth option must come from a line the reader has NOT already quoted,
 * or recognizing it again would prove nothing about memory. `decoyPool` is a
 * flat pool of lines drawn from other pages in the same run.
 *
 * Returns `{ usable: false, … }` rather than throwing when no honest truth
 * candidate exists (every line already quoted) or too few decoys are
 * available — a whole corpus run should never abort over one page's probe.
 */
export function pickRecognitionProbe(
  pageLines: readonly string[],
  alreadyQuoted: readonly string[],
  decoyPool: readonly string[],
  rng: Rng,
): ProbeResult {
  const quoted = alreadyQuoted.map(normalizeForMatch).filter((s) => s.length > 0);
  const candidates = pageLines
    .map((l) => l.trim())
    .filter((line) => {
      if (line.length === 0) return false;
      const norm = normalizeForMatch(line);
      return !quoted.some((q) => norm.includes(q) || q.includes(norm));
    });

  if (candidates.length === 0) return UNUSABLE;

  const truth = pickOne(candidates, rng);
  const truthNorm = normalizeForMatch(truth);
  const decoyCandidates = decoyPool
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && normalizeForMatch(l) !== truthNorm);
  // Dedupe the decoy pool so the same sibling line can't fill two slots.
  const uniqueDecoys = Array.from(new Map(decoyCandidates.map((l) => [normalizeForMatch(l), l])).values());
  if (uniqueDecoys.length < 3) return UNUSABLE;

  const decoys = shuffle(uniqueDecoys, rng).slice(0, 3);
  const positioned = shuffle(
    [
      { text: truth, isTruth: true },
      ...decoys.map((text) => ({ text, isTruth: false })),
    ],
    rng,
  );
  const correctIndex = positioned.findIndex((o) => o.isTruth) as 0 | 1 | 2 | 3;
  const options = positioned.map((o) => o.text) as unknown as readonly [
    string,
    string,
    string,
    string,
  ];

  return { options, correctIndex, usable: true };
}
