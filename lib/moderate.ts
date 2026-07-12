import { config, type ModerationModel, type ModerationPolicy } from "./config";
import { devLog } from "./log";
import { recordModelCall } from "./modelStats";
import { monitor } from "./monitor";
import { getOpenRouter } from "./openrouter";

/**
 * Moderation (docs/architecture.md §7, legal.md). The safety gate before a page
 * is stored: never store narrow illegal content. **No aesthetic filtering** —
 * darkness and strangeness are features.
 *
 * A pool of free models (mixed deterministic/non, config.moderationModels) is
 * run in parallel; each returns PASS / FAIL / abstain. The combined verdict
 * follows config.moderationPolicy. If every model abstains the result is
 * undetermined and we throw — the caller releases the reservation and the
 * address is retried later, so unmoderated content is never stored and a
 * transient outage never permanently dark-shelves a page.
 */

export interface ModerationResult {
  ok: boolean;
}

// One loud warning per process when the safety gate is switched off, so a
// temporary MODERATION_ENABLED=false can never be silently left on.
let warnedDisabled = false;
function warnModerationDisabled(): void {
  if (warnedDisabled) return;
  warnedDisabled = true;
  console.warn(
    "[noumenon] ⚠ MODERATION DISABLED — storing pages unmoderated (MODERATION_ENABLED=false)",
  );
  // Audit trail (once per process): a knowingly-unmoderated deploy — the
  // ALLOW_UNMODERATED escape in production, or the dev unblock — is never silent.
  void monitor("moderation_disabled_in_production");
}

const MODERATION_PROMPT = [
  "You are a content safety classifier for a library of machine-generated",
  "fiction. Decide only whether the text contains NARROW ILLEGAL content:",
  "sexual content involving minors, or credible incitement to violence or",
  "other serious crime.",
  "",
  "This is NOT taste or tone moderation. Darkness, strangeness, horror,",
  "obscenity, the disturbing, the bleak, and the sexual-between-adults are all",
  "ALLOWED — they are features of this library, not violations.",
  "",
  "Reply with exactly one word: PASS if the text is allowed, FAIL if it",
  "contains the narrow illegal content above. No explanation.",
].join("\n");

export type Verdict = "pass" | "fail" | "abstain";

/** Parse a model reply into a verdict; anything unclear abstains. */
function parseVerdict(reply: string | null | undefined): Verdict {
  if (!reply) return "abstain";
  const text = reply.toUpperCase();
  const hasFail = text.includes("FAIL");
  const hasPass = text.includes("PASS");
  if (hasFail === hasPass) return "abstain"; // both or neither → unclear
  return hasFail ? "fail" : "pass";
}

/**
 * Classify one text with one moderation-pool model. Records its outcome to
 * model_stats (lib/modelStats.ts) fire-and-forget — the same shared table
 * generation reads for latency-weighted picks, so a model that's reliably
 * slow-but-free here (tolerable: this fan-out is parallel and abstain-on-
 * error) still surfaces as slow if it's ever added to the generation pool.
 * Errors are rethrown unchanged so the existing Promise.allSettled → abstain
 * behavior in moderate() is untouched.
 */
async function classify(
  entry: ModerationModel,
  text: string,
): Promise<Verdict> {
  const startedAt = Date.now();
  try {
    const response = await getOpenRouter().chat.completions.create({
      model: entry.model,
      temperature: entry.temperature,
      max_tokens: config.moderationMaxTokens,
      messages: [
        { role: "system", content: MODERATION_PROMPT },
        { role: "user", content: text },
      ],
    });
    void recordModelCall(entry.model, { ms: Date.now() - startedAt, ok: true });
    return parseVerdict(response.choices[0]?.message.content);
  } catch (err) {
    void recordModelCall(entry.model, { ms: Date.now() - startedAt, ok: false });
    throw err;
  }
}

/**
 * Combine decided (non-abstain) verdicts into a pass/fail per policy. Pure and
 * exported for testing. Callers must pass at least one decided verdict.
 */
export function combineVerdicts(
  verdicts: Verdict[],
  policy: ModerationPolicy,
): ModerationResult {
  const fails = verdicts.filter((v) => v === "fail").length;
  const passes = verdicts.filter((v) => v === "pass").length;

  switch (policy) {
    case "any-fail":
      return { ok: fails === 0 };
    case "unanimous-fail":
      return { ok: passes > 0 };
    case "majority":
      return { ok: passes >= fails };
  }
}

export async function moderate(text: string): Promise<ModerationResult> {
  if (!config.moderationEnabled) {
    // Fail-closed in production: never store unmoderated content (architecture
    // §7 invariant, docs/legal.md). Throwing makes resolvePage release the
    // reservation → the page renders explore-only instead of being committed
    // unmoderated. Outside production the disabled state is a local dev unblock
    // (loud one-time warning only). Enabling the pool for real is Phase 9.
    if (config.isProduction && !config.allowUnmoderated) {
      void monitor("moderation_disabled_in_production");
      throw new Error(
        "Moderation is disabled in production — refusing to store unmoderated content",
      );
    }
    // Escape hatch (ALLOW_UNMODERATED) or non-production dev unblock: skip the
    // gate. warnModerationDisabled() leaves a loud, once-per-process warning +
    // audit event so a knowingly-unmoderated deploy is never silent in the logs.
    warnModerationDisabled();
    return { ok: true };
  }

  const results = await Promise.allSettled(
    config.moderationModels.map((entry) => classify(entry, text)),
  );

  const verdicts: Verdict[] = [];
  results.forEach((result, i) => {
    const entry = config.moderationModels[i];
    if (result.status === "fulfilled") {
      verdicts.push(result.value);
      devLog(
        `moderate ${entry.model} temp=${entry.temperature} → ${result.value}`,
      );
    } else {
      devLog(
        `moderate ${entry.model} temp=${entry.temperature} → error (abstain):`,
        result.reason instanceof Error ? result.reason.message : result.reason,
      );
    }
  });

  const decided = verdicts.filter((v) => v !== "abstain");
  if (decided.length === 0) {
    // Undetermined — no model gave a usable verdict. Do not store; retry later.
    throw new Error("Moderation undetermined: no model returned a verdict");
  }

  const result = combineVerdicts(decided, config.moderationPolicy);
  devLog(`moderate decision=${result.ok ? "PASS" : "FAIL"} (policy=${config.moderationPolicy})`);
  return result;
}
