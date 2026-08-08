/**
 * Aggregation and Markdown rendering for a read-eval run. Pure: every tally,
 * rate, and breakdown here is computed from data passed in, with no LLM and
 * no I/O, so it's fully unit-testable from fixture data
 * (scripts/read-eval.mts owns the corpus query, the model calls, and
 * `writeFile` — everything impure).
 */

import type { ViewportProfile } from "./layout.ts";
import type { QuoteCheck, ReadingTrace } from "./verdict.ts";
import { detectEcho, hasQuoteFailure, ruleVerdict, verifyQuotes } from "./verdict.ts";
import type { CalibrationResult } from "./calibrate.ts";

export type RunKind = "sample" | "control-bland" | "control-shuffled";

export interface PageRunMeta {
  address: string;
  kind: RunKind;
  /** Generation model — absent for a bland control (no source page). */
  model?: string;
  promptVariant?: string;
  temperature?: number;
  committedAt?: string;
  likes?: number;
  dislikes?: number;
  visits?: number;
  medianDwellMs?: number;
}

export interface PageRun {
  meta: PageRunMeta;
  /** The wrapped lines the reader actually saw, at the run's viewport
   * profile — what `verifyQuotes` checks citations against. */
  lines: string[];
  /** Index of the first line at/below the fold (PageSnapshot.foldLine),
   * for the report's line-numbered rendering. */
  foldLine: number;
  trace: ReadingTrace;
}

export interface ReportConfig {
  timestamp: string; // ISO
  corpusDescription: string; // e.g. "status='ok', seed=7, limit=20"
  viewportProfile: ViewportProfile;
  charsPerLine: number;
  foldLines: number;
  landingLines: number;
  protocolVersion: string;
  readerModel: string;
  readerTemperature: number;
  verdictTemperature: number;
  estimatedCostUsd?: number;
}

export interface PageAnalysis {
  run: PageRun;
  rule: ReturnType<typeof ruleVerdict>;
  quoteChecks: QuoteCheck[];
  unreliable: boolean; // a quote failed verification, or the trace errored
  echoes: ReturnType<typeof detectEcho>;
  modelVerdict: ReadingTrace["modelVerdict"];
  agrees: boolean | null; // rule vs model verdict agreement; null if either is missing
}

export interface Tally {
  scored: number; // sample pages with a valid, non-error, non-unreliable trace
  pause: number;
  hollow: number;
  bounce: number;
  unreliable: number;
  errored: number;
  abstainedStages: number;
  landingContinueRate: number | null;
  recallSurvivalRate: number | null;
  recognition: { correct: number; usable: number; baseline: number };
  backHold: number;
  backConfusion: number;
}

export interface AggregateResult {
  analyses: PageAnalysis[]; // sample pages, in input order
  controls: PageAnalysis[]; // injected controls, in input order
  tally: Tally;
  controlFailures: PageAnalysis[]; // controls that scored "pause" — invalidates the run
  familyCollision: boolean;
  byModel: Map<string, Tally>;
  byVariant: Map<string, Tally>;
  disagreements: PageAnalysis[]; // rule verdict != model verdict, sample pages only
}

function analyze(run: PageRun): PageAnalysis {
  const { trace } = run;
  if (trace.error) {
    return {
      run,
      rule: ruleVerdict(trace),
      quoteChecks: [],
      unreliable: true,
      echoes: {},
      modelVerdict: undefined,
      agrees: null,
    };
  }
  const quoteChecks = verifyQuotes(trace, run.lines);
  const rule = ruleVerdict(trace);
  const modelVerdict = trace.modelVerdict;
  const agrees =
    modelVerdict?.verdict != null ? modelVerdict.verdict === rule.verdict : null;
  return {
    run,
    rule,
    quoteChecks,
    unreliable: hasQuoteFailure(quoteChecks),
    echoes: detectEcho(trace),
    modelVerdict,
    agrees,
  };
}

function emptyTally(): Tally {
  return {
    scored: 0,
    pause: 0,
    hollow: 0,
    bounce: 0,
    unreliable: 0,
    errored: 0,
    abstainedStages: 0,
    landingContinueRate: null,
    recallSurvivalRate: null,
    recognition: { correct: 0, usable: 0, baseline: 0.25 },
    backHold: 0,
    backConfusion: 0,
  };
}

/** Fold one page's analysis into a running tally. Only pages that are
 * neither errored nor unreliable count toward the scored verdict tally and
 * rate denominators — an integrity failure excludes a page from the numbers
 * rather than silently keeping a possibly-fabricated verdict in them. */
function foldInto(tally: Tally, a: PageAnalysis): void {
  if (a.run.trace.error) {
    tally.errored++;
    return;
  }
  tally.abstainedStages += a.run.trace.stages.filter((s) => s.abstained).length;
  if (a.unreliable) {
    tally.unreliable++;
    return;
  }
  tally.scored++;
  tally[a.rule.verdict]++;

  const landing = a.run.trace.stages.find((s) => s.window.id === "landing");
  if (landing) {
    const next = landing.reply.NEXT?.toUpperCase();
    if (next === "CONTINUE" || next === "STOP") {
      landingContinueTally(tally, next === "CONTINUE");
    }
  }
  recallSurvivalTally(tally, a.rule.survived);

  if (a.run.trace.probe?.usable) {
    tally.recognition.usable++;
    if (a.rule.probeCorrect) tally.recognition.correct++;
  }

  for (const stage of a.run.trace.stages) {
    const why = stage.reply.WHY?.toUpperCase();
    if (why?.includes("HOLD")) tally.backHold++;
    if (why?.includes("CONFUSION")) tally.backConfusion++;
  }
}

// Rate accumulators are tracked as running counts via closure-free helpers on
// the tally object itself, using two hidden counters folded into the public
// rate field only at the end (finalizeTally). To keep Tally's public shape
// simple, we accumulate numerators/denominators in local maps keyed by the
// tally's identity during a single aggregate() pass instead of mutating
// hidden fields on Tally.
const landingCounts = new WeakMap<Tally, { yes: number; total: number }>();
const recallCounts = new WeakMap<Tally, { yes: number; total: number }>();

function landingContinueTally(tally: Tally, continued: boolean): void {
  const c = landingCounts.get(tally) ?? { yes: 0, total: 0 };
  c.total++;
  if (continued) c.yes++;
  landingCounts.set(tally, c);
}

function recallSurvivalTally(tally: Tally, survived: boolean): void {
  const c = recallCounts.get(tally) ?? { yes: 0, total: 0 };
  c.total++;
  if (survived) c.yes++;
  recallCounts.set(tally, c);
}

function finalizeTally(tally: Tally): void {
  const landing = landingCounts.get(tally);
  const recall = recallCounts.get(tally);
  tally.landingContinueRate = landing && landing.total > 0 ? landing.yes / landing.total : null;
  tally.recallSurvivalRate = recall && recall.total > 0 ? recall.yes / recall.total : null;
}

/** Reader model family, for the self-preference warning (plan §"Family
 * separation warning") — coarse, matching on the slug's leading vendor
 * segment (e.g. "anthropic/claude-haiku-4.5" -> "anthropic"). */
function modelFamily(slug: string): string {
  return slug.split("/")[0] ?? slug;
}

export function aggregate(runs: readonly PageRun[]): AggregateResult {
  const analyses: PageAnalysis[] = [];
  const controls: PageAnalysis[] = [];
  const tally = emptyTally();
  const byModel = new Map<string, Tally>();
  const byVariant = new Map<string, Tally>();

  for (const run of runs) {
    const a = analyze(run);
    if (run.meta.kind === "sample") {
      analyses.push(a);
      foldInto(tally, a);

      if (run.meta.model) {
        const t = byModel.get(run.meta.model) ?? emptyTally();
        foldInto(t, a);
        byModel.set(run.meta.model, t);
      }
      if (run.meta.promptVariant) {
        const t = byVariant.get(run.meta.promptVariant) ?? emptyTally();
        foldInto(t, a);
        byVariant.set(run.meta.promptVariant, t);
      }
    } else {
      controls.push(a);
    }
  }

  finalizeTally(tally);
  for (const t of byModel.values()) finalizeTally(t);
  for (const t of byVariant.values()) finalizeTally(t);

  const controlFailures = controls.filter((a) => !a.unreliable && a.rule.verdict === "pause");

  const readerFamily = runs.length > 0 ? modelFamily(runs[0].trace.readerModel) : "";
  const familyCollision = runs.some(
    (r) => r.meta.model != null && modelFamily(r.meta.model) === readerFamily,
  );

  const disagreements = analyses.filter((a) => a.agrees === false);

  return { analyses, controls, tally, controlFailures, familyCollision, byModel, byVariant, disagreements };
}

// --- Markdown rendering ----------------------------------------------------

function pct(n: number | null): string {
  return n == null ? "n/a" : `${Math.round(n * 100)}%`;
}

function frac(numerator: number, denominator: number): string {
  return denominator > 0 ? `${numerator} / ${denominator} (${pct(numerator / denominator)})` : "n/a";
}

function tallyLines(t: Tally): string[] {
  return [
    `- scored: ${t.scored}  (unreliable: ${t.unreliable} · errored: ${t.errored} · abstained stages: ${t.abstainedStages})`,
    `- pause: ${t.pause} · hollow: ${t.hollow} · bounce: ${t.bounce}`,
    `- landing continue rate: ${pct(t.landingContinueRate)}`,
    `- recall survival rate: ${pct(t.recallSurvivalRate)}`,
    `- recognition accuracy: ${frac(t.recognition.correct, t.recognition.usable)} (chance: ${pct(t.recognition.baseline)})`,
    `- regression — BACK/HOLD: ${t.backHold} · BACK/CONFUSION: ${t.backConfusion} (never summed; self-reported, low reliability)`,
  ];
}

/** Line-numbered rendering of a page's wrapped text with a fold marker — the
 * exact input the reader saw at each stage, laid out for a human to eyeball
 * against the real rendered page. */
function renderLinesWithFold(lines: string[], foldLine: number): string {
  const width = String(lines.length).length;
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (i === foldLine) out.push("     " + "-".repeat(10) + " fold " + "-".repeat(10));
    out.push(`${String(i + 1).padStart(width)}  ${line}`);
  });
  if (foldLine >= lines.length) out.push("     " + "-".repeat(10) + " fold (below) " + "-".repeat(10));
  return out.join("\n");
}

function renderControls(controls: PageAnalysis[]): string[] {
  if (controls.length === 0) return ["_No controls in this run._"];
  return controls.map((a) => {
    const label = a.run.meta.kind === "control-bland" ? "bland fixture" : "sentence-shuffled";
    const verdict = a.unreliable ? "unreliable" : a.rule.verdict;
    const flag = !a.unreliable && a.rule.verdict === "pause" ? " ⚠ PAUSED" : "";
    return `- ${label} (\`${a.run.meta.address}\`): **${verdict}**${flag}`;
  });
}

function renderBreakdown(title: string, byKey: Map<string, Tally>): string {
  if (byKey.size === 0) return `### ${title}\n\n_No data._`;
  const rows = Array.from(byKey.entries()).map(([key, t]) => {
    const n = t.scored;
    const low = n > 0 && n < 5 ? " _(low N)_" : "";
    return `| \`${key}\` | ${n}${low} | ${t.pause} | ${t.hollow} | ${t.bounce} | ${pct(t.recallSurvivalRate)} |`;
  });
  return [
    `### ${title}`,
    "",
    "| | scored | pause | hollow | bounce | recall survival |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

function renderPage(a: PageAnalysis, index: number): string {
  const { run } = a;
  const meta = run.meta;
  const header =
    meta.kind === "sample"
      ? `${index}. \`${meta.address}\`  — rule: **${a.unreliable ? "unreliable" : a.rule.verdict}**` +
        (a.modelVerdict?.verdict ? ` · model: **${a.modelVerdict.verdict}**` : "") +
        (a.agrees === false ? " ⚠ disagreement" : "")
      : `${index}. control (${meta.kind === "control-bland" ? "bland fixture" : "sentence-shuffled"})  — rule: **${a.unreliable ? "unreliable" : a.rule.verdict}**`;

  const provenance =
    meta.kind === "sample"
      ? [
          `model: ${meta.model ?? "—"} · variant: ${meta.promptVariant ?? "—"} · temp: ${meta.temperature ?? "—"}`,
          `signals: ${meta.likes ?? 0} likes · ${meta.dislikes ?? 0} dislikes · ${meta.visits ?? 0} visits · median dwell ${meta.medianDwellMs ?? "—"}ms`,
        ]
      : [];

  const quoteFailures = a.quoteChecks.filter((c) => !c.ok);
  const integrity =
    quoteFailures.length > 0
      ? [`⚠ quote-integrity failure: ${quoteFailures.map((c) => `${c.stageId}.${c.field}`).join(", ")}`]
      : [];

  const echoNotes = Object.entries(a.echoes)
    .filter(([, echoed]) => echoed)
    .map(([field]) => `recall.${field} echoes an earlier stage's own words`);

  const stageBlocks = run.trace.stages.map((s) => {
    const fields = Object.entries(s.reply)
      .map(([k, v]) => `${k}: ${v ?? "NOTHING"}`)
      .join(" · ");
    const seenNote = s.window.kind === "blind" ? "(no text shown)" : `(${s.window.upToLine} line(s) shown)`;
    return `  - **${s.window.id}** ${seenNote} — ${fields}${s.abstained ? " _(abstained)_" : ""}`;
  });

  const probeLine = run.trace.probe
    ? run.trace.probe.usable
      ? `probe: picked ${run.trace.probe.picked ?? "—"}, correct was option ${["A", "B", "C", "D"][run.trace.probe.correctIndex]} — ${a.rule.probeCorrect ? "correct" : "incorrect"}`
      : "probe: unusable for this page"
    : "";

  return [
    header,
    "",
    ...provenance,
    ...integrity,
    ...echoNotes,
    probeLine,
    "",
    ...stageBlocks,
    "",
    "<details>",
    "<summary>wrapped rendering</summary>",
    "",
    "```",
    renderLinesWithFold(run.lines, run.foldLine),
    "```",
    "",
    "</details>",
    "",
    "human: `[ ]`  (pause / hollow / blank — for --calibrate)",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export function renderReport(
  config: ReportConfig,
  result: AggregateResult,
  calibration?: CalibrationResult,
): string {
  const lines: string[] = [];

  if (result.controlFailures.length > 0) {
    lines.push(
      "## ⚠ THIS RUN'S VERDICTS ARE NOT TRUSTWORTHY",
      "",
      `${result.controlFailures.length} negative control(s) scored **pause** — a bland fixture or a` +
        " sentence-shuffled page should never pause a reader. Tallies below are printed for" +
        " inspection but should not be quoted or acted on.",
      "",
    );
  }
  if (result.familyCollision) {
    lines.push(
      "## ⚠ Reader/generator family collision",
      "",
      `The reader model (${config.readerModel}) shares a vendor family with at least one` +
        " generation model in this sample — per-model breakdowns may be contaminated by" +
        " self-preference.",
      "",
    );
  }

  lines.push(
    `# Read-eval report`,
    "",
    `Generated ${config.timestamp}`,
    "",
    `- corpus: ${config.corpusDescription}`,
    `- viewport: ${config.viewportProfile}  (${config.charsPerLine} chars/line, fold at line ${config.foldLines}, landing window ${config.landingLines} lines)`,
    `- protocol: ${config.protocolVersion}`,
    `- reader: ${config.readerModel}  (reading temp ${config.readerTemperature}, verdict temp ${config.verdictTemperature})`,
    config.estimatedCostUsd != null ? `- estimated cost: ~$${config.estimatedCostUsd.toFixed(2)}` : "",
    "",
    "**Runs at different protocol versions or reader models must not be compared.**",
    "",
    "---",
    "",
    "## Controls",
    "",
    ...renderControls(result.controls),
    "",
    "## Tally",
    "",
    ...tallyLines(result.tally),
    "",
  );

  if (calibration) {
    lines.push(
      "## Calibration",
      "",
      `Matched ${calibration.matched} of ${calibration.n} human-marked addresses from the` +
        " comparison file against this run's corpus.",
      "",
      `- agreement rate: ${pct(calibration.agreementRate)}`,
      `- true positive (human pause, model pause): ${calibration.truePositive}`,
      `- false negative (human pause, model not-pause): ${calibration.falseNegative}`,
      `- false positive (human hollow, model pause): ${calibration.falsePositive}`,
      `- true negative (human hollow, model not-pause): ${calibration.trueNegative}`,
      calibration.n < 20
        ? "- **N is small — treat this as a smoke test, not a validated agreement figure.**"
        : "",
      "",
    );
  }

  lines.push(
    renderBreakdown("By generation model", result.byModel),
    "",
    renderBreakdown("By prompt variant", result.byVariant),
    "",
    "## Disagreements (rule verdict ≠ model verdict)",
    "",
    result.disagreements.length === 0
      ? "_None — the rule verdict and the page-blind model verdict agreed on every scored page._"
      : result.disagreements
          .map((a) => `- \`${a.run.meta.address}\` — rule: ${a.rule.verdict}, model: ${a.modelVerdict?.verdict}`)
          .join("\n"),
    "",
    "---",
    "",
    "## Per page",
    "",
    ...[...result.controls, ...result.analyses].map((a, i) => renderPage(a, i + 1)),
  );

  return lines.filter((l) => l !== undefined).join("\n");
}
