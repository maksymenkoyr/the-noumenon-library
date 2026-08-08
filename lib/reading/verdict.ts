/**
 * The reading trace, its integrity checks, and the deterministic rule
 * verdict. Adjudication happens here, deliberately *outside* the reading
 * conversation and *without* the page in context for the model verdict (built
 * by the harness as a fresh call — see scripts/read-eval.mts) — a judge
 * holding both the page and the trace is the critic-with-foresight this whole
 * design exists to avoid (plan §"The one structural rule").
 */

import type { StageId, StageWindow } from "./stages.ts";
import { renderWindow } from "./stages.ts";
import type { StageReply } from "./protocol.ts";

export interface StageResult {
  window: StageWindow;
  reply: StageReply;
  /** The model's raw text for this turn — kept for the report's per-page
   * transcript dump, and for `detectEcho`/debugging. */
  raw: string;
  abstained: boolean;
}

/** The forced-choice recognition probe for one page (./probe.ts builds the
 * options; the harness fills `picked`/`sure` in once the reader answers). */
export interface ProbeResult {
  options: readonly [string, string, string, string];
  correctIndex: 0 | 1 | 2 | 3;
  /** False when no line existed that the reader hadn't already quoted, so no
   * honest "unseen truth" option could be built — the probe is printed but
   * excluded from aggregate accuracy. */
  usable: boolean;
  picked?: "A" | "B" | "C" | "D";
  sure?: boolean | null;
}

export interface ReadingTrace {
  address: string;
  protocolVersion: string;
  readerModel: string;
  temperature: number;
  stages: StageResult[];
  probe?: ProbeResult;
  modelVerdict?: ModelVerdictReply;
  /** Set instead of a full `stages` walk when a provider call failed outright
   * (not a moderation-style abstain — an actual request error). A traced-but-
   * errored page is printed in the report and excluded from every aggregate. */
  error?: string;
}

export interface ModelVerdictReply {
  verdict: "pause" | "hollow" | "bounce" | null;
  evidence: string | null;
  confidence: "high" | "low" | null;
  raw: string;
}

// --- Quote integrity -------------------------------------------------------

export interface QuoteCheck {
  stageId: StageId;
  field: string;
  value: string;
  ok: boolean;
}

/** Verbatim-citation fields checked per stage family — everything else
 * (GUESS, PULL, WHY, NEXT, FEEL, …) is a description or a choice, not a
 * claimed quote, and isn't checked here. Exported so scripts/read-eval.mts
 * can collect the same "already quoted" fragments this module verifies,
 * for the recognition probe's truth-candidate exclusion (./probe.ts). */
export const QUOTE_FIELDS: Record<string, readonly string[]> = {
  landing: ["CAUGHT"],
  screen: ["STOPPED", "BACK", "AT"],
  end: ["DRIFT", "BACK"],
  recall: ["LINE"],
};

export function stageFamily(id: StageId): "landing" | "screen" | "end" | "recall" | "probe" {
  if (id === "landing" || id === "end" || id === "recall" || id === "probe") return id;
  return "screen";
}

/** Normalize for substring comparison: strip surrounding quote marks,
 * lowercase, collapse whitespace. Loose on purpose — the point is to catch
 * fabrication, not to penalize a trailing period the model added. */
export function normalizeQuote(s: string): string {
  return s
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verify every verbatim-citation field against the text the reader had
 * actually seen by that stage (or, for `recall`, against the whole page — it
 * runs after every reveal window). A failing check marks the page
 * `unreliable` (plan §"Anti-flattery" — verbatim citation, machine-verified).
 */
export function verifyQuotes(trace: ReadingTrace, fullLines: string[]): QuoteCheck[] {
  const fullText = normalizeQuote(fullLines.join("\n"));
  const checks: QuoteCheck[] = [];

  for (const stage of trace.stages) {
    const family = stageFamily(stage.window.id);
    const fields = QUOTE_FIELDS[family];
    if (!fields) continue;
    const scopeText =
      family === "recall" ? fullText : normalizeQuote(renderWindow(fullLines, stage.window));

    for (const field of fields) {
      const value = stage.reply[field];
      if (value == null) continue; // NOTHING / unmatched — nothing to verify
      const normalized = normalizeQuote(value);
      const ok = normalized.length > 0 && scopeText.includes(normalized);
      checks.push({ stageId: stage.window.id, field, value, ok });
    }
  }
  return checks;
}

export function hasQuoteFailure(checks: readonly QuoteCheck[]): boolean {
  return checks.some((c) => !c.ok);
}

// --- Echo detection ----------------------------------------------------

/**
 * Flag a recall field that is really just a repeat of the reader's own
 * earlier answer, still visible to it in the pruned transcript
 * (`[system, ...assistantAnswersOnly]` — plan §"Context carry"). Retrieving
 * your own last message is not memory of the page; it's copy-paste.
 */
export function detectEcho(trace: ReadingTrace): Partial<Record<"IMAGE" | "LINE" | "FEEL", boolean>> {
  const recall = trace.stages.find((s) => s.window.id === "recall");
  if (!recall) return {};

  const priorValues = trace.stages
    .filter((s) => s.window.id !== "recall" && s.window.id !== "probe")
    .flatMap((s) => Object.values(s.reply))
    .filter((v): v is string => v != null)
    .map(normalizeQuote)
    .filter((v) => v.length > 0);

  const echoes: Partial<Record<"IMAGE" | "LINE" | "FEEL", boolean>> = {};
  for (const field of ["IMAGE", "LINE", "FEEL"] as const) {
    const value = recall.reply[field];
    if (value == null) continue;
    const normalized = normalizeQuote(value);
    echoes[field] =
      normalized.length > 0 &&
      priorValues.some((p) => p.includes(normalized) || normalized.includes(p));
  }
  return echoes;
}

// --- Rule verdict ------------------------------------------------------

export interface RuleVerdict {
  verdict: "pause" | "hollow" | "bounce";
  /** Something reconstructable survived the recall stage — IMAGE, LINE, or
   * FEEL was answered. The primary "something survived" evidence. */
  survived: boolean;
  /** Correctly picked this page's line out of the recognition probe, or
   * `null` when the probe was unusable for this page. Objective; immune to
   * politeness. */
  probeCorrect: boolean | null;
  /** A WHY:HOLD appeared anywhere — self-reported, low reliability on its
   * own (plan §"Regression, elicited honestly"): never sufficient alone to
   * call `pause`, only corroborating. */
  holdSignal: boolean;
  confusionSignal: boolean;
  /** The reader said STOP at the very first (landing) stage. */
  earlyStop: boolean;
  /** holdSignal was present alongside the actual deciding evidence — the
   * strongest available combination, worth flagging in the report even
   * though it isn't what decided the verdict. */
  corroborated: boolean;
}

/**
 * Deterministic, auditable verdict from the trace alone. `survived` or
 * `probeCorrect` is REQUIRED for `pause` — regression (`BACK`/`WHY:HOLD`) is
 * never, by itself, sufficient (plan §"Never let it stand alone"): a model
 * has no eyes, and "where my eye went" is confabulation unless something
 * outside that same self-report corroborates it.
 */
export function ruleVerdict(trace: ReadingTrace): RuleVerdict {
  const recall = trace.stages.find((s) => s.window.id === "recall");
  const survived =
    !!recall && (["IMAGE", "LINE", "FEEL"] as const).some((f) => recall.reply[f] != null);

  const landing = trace.stages.find((s) => s.window.id === "landing");
  const earlyStop = (landing?.reply.NEXT ?? "").toUpperCase() === "STOP";

  let holdSignal = false;
  let confusionSignal = false;
  for (const stage of trace.stages) {
    const why = stage.reply.WHY?.toUpperCase();
    if (!why) continue;
    if (why.includes("HOLD")) holdSignal = true;
    if (why.includes("CONFUSION")) confusionSignal = true;
  }

  const probeCorrect =
    trace.probe?.usable && trace.probe.picked != null
      ? ["A", "B", "C", "D"].indexOf(trace.probe.picked) === trace.probe.correctIndex
      : null;

  const verdict: RuleVerdict["verdict"] =
    survived || probeCorrect === true ? "pause" : earlyStop ? "bounce" : "hollow";

  return {
    verdict,
    survived,
    probeCorrect,
    holdSignal,
    confusionSignal,
    earlyStop,
    corroborated: holdSignal && (survived || probeCorrect === true),
  };
}

/** Parse the fresh, page-blind verdict call's reply (VERDICT/EVIDENCE/CONFIDENCE
 * — see protocol.ts's `buildVerdictSystemPrompt`, `VERDICT_FIELDS`). */
export function parseModelVerdict(raw: string): ModelVerdictReply {
  const verdictMatch = raw.match(/^[ \t]*VERDICT[ \t]*:[ \t]*(.*)$/im);
  const evidenceMatch = raw.match(/^[ \t]*EVIDENCE[ \t]*:[ \t]*(.*)$/im);
  const confidenceMatch = raw.match(/^[ \t]*CONFIDENCE[ \t]*:[ \t]*(.*)$/im);

  const verdictWord = verdictMatch?.[1].trim().toUpperCase() ?? "";
  const verdict: ModelVerdictReply["verdict"] = verdictWord.includes("PAUSE")
    ? "pause"
    : verdictWord.includes("HOLLOW")
      ? "hollow"
      : verdictWord.includes("BOUNCE")
        ? "bounce"
        : null;

  const confidenceWord = confidenceMatch?.[1].trim().toUpperCase() ?? "";
  const confidence: ModelVerdictReply["confidence"] = confidenceWord.includes("HIGH")
    ? "high"
    : confidenceWord.includes("LOW")
      ? "low"
      : null;

  const evidence = evidenceMatch?.[1].trim() || null;

  return { verdict, evidence, confidence, raw };
}
