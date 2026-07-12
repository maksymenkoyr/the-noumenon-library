import { config } from "./config";
import { devLog } from "./log";
import { monitor } from "./monitor";
import { cooldownSeconds, errorStatus, getClient, reasoningParams } from "./providers";
import { markCooling, markHealthy, markUnavailable, moderationChain, type RegistryRow } from "./registry";

/**
 * Moderation (docs/architecture.md §7, legal.md). The safety gate before a page
 * is stored: never store narrow illegal content. **No aesthetic filtering** —
 * darkness and strangeness are features.
 *
 * A short, curated CHAIN of models (model_registry, task='moderation', ordered
 * by `order` — lib/registry.ts moderationChain()) is walked in order until one
 * returns a clear PASS/FAIL; an abstain or an error just moves to the next
 * link. This is deliberately NOT a parallel any-fail pool: every extra voter
 * is another chance to wrongly FAIL benign-but-dark content, over-blocking it
 * against the "darkness is a feature" ethos. If every model in the chain
 * abstains or errors, the result is undetermined and we throw — the caller
 * releases the reservation and the address is retried later, so unmoderated
 * content is never stored and a transient outage never permanently
 * dark-shelves a page.
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

async function classify(row: RegistryRow, text: string): Promise<Verdict> {
  const client = getClient(row.provider);
  if (!client) {
    // Shouldn't happen — moderationChain() already filters to providers with
    // a configured key — but stay defensive rather than crash the request.
    return "abstain";
  }
  const response = await client.chat.completions.create({
    model: row.slug,
    temperature: row.temperature,
    max_tokens: row.maxTokens,
    messages: [
      { role: "system", content: MODERATION_PROMPT },
      { role: "user", content: text },
    ],
    ...reasoningParams(row.provider),
  });
  return parseVerdict(response.choices[0]?.message.content);
}

/** Mark health on a chain link's failure — same transitions as generation. */
function markFailure(row: RegistryRow, err: unknown): void {
  const status = errorStatus(err);
  if (status === 404) {
    void markUnavailable(row.slug, "moderation");
  } else if (status === 429 || status === undefined || status >= 500) {
    void markCooling(
      row.slug,
      "moderation",
      new Date(Date.now() + cooldownSeconds(err) * 1000),
    );
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

  const chain = await moderationChain();
  // An empty chain (misconfigured registry, every provider key missing, or
  // every model unavailable/cooling) falls straight through the loop below
  // and hits the same "undetermined" throw as every model abstaining.
  for (const row of chain) {
    let verdict: Verdict;
    try {
      verdict = await classify(row, text);
      void markHealthy(row.slug, "moderation");
    } catch (err) {
      devLog(
        `moderate ${row.slug} → error (abstain):`,
        err instanceof Error ? err.message : String(err),
      );
      markFailure(row, err);
      continue; // error → next link in the chain
    }

    devLog(`moderate ${row.slug} temp=${row.temperature} → ${verdict}`);
    if (verdict === "abstain") continue; // unclear reply → next link

    devLog(`moderate decision=${verdict === "pass" ? "PASS" : "FAIL"} (model=${row.slug})`);
    return { ok: verdict === "pass" };
  }

  // Every link in the chain abstained, errored, or the chain was empty —
  // undetermined. Do not store; retry later.
  throw new Error("Moderation undetermined: no model returned a verdict");
}
