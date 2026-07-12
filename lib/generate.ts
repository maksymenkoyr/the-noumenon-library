import OpenAI from "openai";
import { config } from "./config";
import type { GenerationUsage } from "./economics";
import { devLog } from "./log";
import {
  FREE_TIER_KEY,
  freeTierOnCooldown,
  getModelStats,
  markRateLimited,
  modelOnCooldown,
  recordModelCall,
  type ModelStat,
} from "./modelStats";
import { getOpenRouter } from "./openrouter";
import {
  buildPrompt,
  DEFAULT_PROMPT_VARIANT,
  GENERATION_FORMS,
} from "./prompts";

/**
 * Generation is a pure function of its levers plus model nondeterminism, and
 * every lever is persisted as provenance (docs/architecture.md §6). The page
 * is given no address and no seed word, so the prompt is identical for every
 * page — variety comes from the model's sampling and from rotating across a
 * pool of models (the "different gravity wells" lever, docs/generation.md).
 * Bundling the levers in one object keeps "what was used" and "what to log"
 * the same thing.
 */
export interface GenerationLevers {
  model: string;
  temperature: number;
  promptVariant: string;
  form: string;
}

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Fisher-Yates shuffle; does not mutate the input. */
function shuffled<T>(pool: readonly T[]): T[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isFree(model: string): boolean {
  return model.endsWith(":free");
}

/** Neutral latency assumption for a model with no samples yet (§ below). */
const DEFAULT_AVG_MS = 5000;

/**
 * Latency-weighted random pick — favors faster models (weight ∝ 1/avgMs) so
 * the pool naturally drifts away from slow members, while every eligible
 * model keeps some chance of being sampled. A model with no data yet is
 * treated as "average speed" (DEFAULT_AVG_MS) rather than dominating (as an
 * artificially-low avgMs would) or starving (as an artificially-high one
 * would) — it earns its real weight once model_stats has samples for it.
 */
function pickByLatency(pool: readonly string[], stats: Map<string, ModelStat>): string {
  const weights = pool.map((m) => 1 / (stats.get(m)?.avgMs ?? DEFAULT_AVG_MS));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1]; // floating-point rounding fallback
}

/** Per-model cooldown after a retryable error — short, since it's per-model. */
const MODEL_COOLDOWN_SECONDS = 60;
/**
 * Cooldown after the OpenRouter account-wide `free-models-per-day` cap trips
 * — long, since the cap doesn't clear until the next UTC day and there is no
 * point re-probing the whole free tier every request until then. 15 minutes
 * bounds the blast radius of a stale cooldown without hammering the API.
 */
const ACCOUNT_FREE_CAP_COOLDOWN_SECONDS = 15 * 60;

/**
 * Whether a failed OpenRouter call is worth retrying on a different pool
 * model: free-tier rate limits (429), transient server errors (5xx), and
 * connection/timeout failures (status undefined). Config errors (400/401/
 * 403/404/...) are not retryable — a different model won't fix a bad
 * request or a bad key, so those rethrow immediately.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false;
  return err.status === undefined || err.status === 429 || err.status >= 500;
}

/**
 * Whether a 429 is OpenRouter's account-wide `free-models-per-day` cap (50
 * requests/day without credits) rather than an ordinary per-model rate
 * limit. This flavor caps every `:free` model at once, so — unlike a normal
 * 429 — cycling the free pool doesn't help; only the paid tail does. Detected
 * primarily by message text; the `x-ratelimit-remaining: 0` header is a
 * fallback for cases where the message wording drifts.
 */
function isAccountFreeCap(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError) || err.status !== 429) return false;
  if (err.message?.toLowerCase().includes("free-models-per-day")) return true;
  return err.headers?.get?.("x-ratelimit-remaining") === "0";
}

/** Base temperature ± a uniform jitter, clamped to a valid sampling range. */
function jitteredTemperature(): number {
  const offset = (Math.random() * 2 - 1) * config.temperatureJitter;
  return Math.min(2, Math.max(0.1, config.temperature + offset));
}

/**
 * Pick the primary model for one generation. Free models are preferred
 * (latency-weighted among those not currently cooling down); the paid safety
 * net (config.paidGenerationModels) is only used when the account-wide
 * free-cap cooldown is active or every free pool member is individually
 * cooling down — i.e. paid spend only happens on free-tier overflow.
 */
function pickPrimaryModel(stats: Map<string, ModelStat>): string {
  const eligibleFree = config.generationModels.filter((m) => !modelOnCooldown(stats, m));
  if (!freeTierOnCooldown(stats) && eligibleFree.length > 0) {
    return pickByLatency(eligibleFree, stats);
  }
  // Free tier capped or fully cooled down — fall to the paid safety net. If
  // none is configured, still return something rather than throw: try free
  // anyway (it may 429 again, but that's the same failure mode as before).
  return config.paidGenerationModels.length > 0
    ? pick(config.paidGenerationModels)
    : pick(config.generationModels);
}

/**
 * Pick the entropy levers for one generation: a latency- and cooldown-aware
 * model pick (free-first, paid on overflow), a random form/register for the
 * page, and a per-page jittered temperature — all logged as provenance so
 * the library's own evolution stays mappable.
 */
export async function chooseLevers(): Promise<GenerationLevers> {
  const stats = await getModelStats();
  const model = pickPrimaryModel(stats);
  const form = pick(GENERATION_FORMS);
  const temperature = jitteredTemperature();
  devLog(
    `generate model=${model} tier=${isFree(model) ? "free" : "paid"} ` +
      `temp=${temperature.toFixed(2)} form="${form}"`,
  );
  return {
    model,
    temperature,
    promptVariant: DEFAULT_PROMPT_VARIANT,
    form,
  };
}

/**
 * A generated page plus what it cost — usage feeds the spend counter (§10).
 * `model` is the pool member that actually answered, which may differ from
 * the model chooseLevers() picked if earlier pool members were skipped on a
 * retryable error — callers should treat this as the true provenance.
 */
export interface GenerationResult {
  text: string;
  model: string;
  usage: GenerationUsage;
}

/**
 * Generate the text found on a page with the given levers. Free-tier models
 * intermittently 429 or fail transiently, so this tries the chosen model
 * first, then falls back through the rest of the free pool (shuffled,
 * cooldown-filtered) and finally the paid safety net on a retryable error —
 * the "different gravity wells" variety lever doubling as availability
 * fallback. A non-retryable error (bad request, bad key, ...) rethrows
 * immediately since no other model would fix it.
 *
 * Every attempt's outcome (success/failure, duration) is recorded to
 * model_stats (lib/modelStats.ts) fire-and-forget, so future picks get
 * better latency data. If OpenRouter's account-wide free-cap 429 is
 * detected, the remaining free attempts are dropped — cycling the capped
 * free tier further would just burn requests for the same error — and the
 * loop jumps straight to the paid tail.
 */
export async function generatePage(
  levers: GenerationLevers,
): Promise<GenerationResult> {
  const prompt = buildPrompt(levers.promptVariant, {
    maxWords: config.pageMaxWords,
    form: levers.form,
  });

  const stats = await getModelStats();
  const freeCapActive = freeTierOnCooldown(stats);
  const restFree = freeCapActive
    ? []
    : shuffled(
        config.generationModels.filter(
          (m) => m !== levers.model && !modelOnCooldown(stats, m),
        ),
      );
  const paidTail = shuffled(
    config.paidGenerationModels.filter((m) => m !== levers.model),
  );

  let attempts = [levers.model, ...restFree, ...paidTail];

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    const startedAt = Date.now();
    try {
      const response = await getOpenRouter().chat.completions.create({
        model,
        temperature: levers.temperature,
        max_tokens: config.maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
      void recordModelCall(model, { ms: Date.now() - startedAt, ok: true });

      const tokens = response.usage?.total_tokens ?? 0;
      const pricePerMillion = config.modelPrices[model] ?? 0;
      const costUsd = (tokens / 1_000_000) * pricePerMillion;

      return {
        text: response.choices[0].message.content ?? "",
        model,
        usage: { tokens, costUsd },
      };
    } catch (err) {
      void recordModelCall(model, { ms: Date.now() - startedAt, ok: false });
      lastErr = err;

      if (isAccountFreeCap(err)) {
        void markRateLimited(FREE_TIER_KEY, ACCOUNT_FREE_CAP_COOLDOWN_SECONDS);
        // The whole free tier is capped for the day — drop any remaining
        // free attempts so the loop jumps straight to the paid tail instead
        // of burning requests on the same account-wide 429.
        attempts = attempts.slice(0, i + 1).concat(
          attempts.slice(i + 1).filter((m) => !isFree(m)),
        );
      } else if (isRetryable(err)) {
        void markRateLimited(model, MODEL_COOLDOWN_SECONDS);
      }

      if (!isRetryable(err) || i === attempts.length - 1) throw err;
      devLog(
        `generate model=${model} failed (${
          err instanceof Error ? err.message : String(err)
        }) → falling back to next pool model`,
      );
    }
  }

  // Unreachable (the loop above always returns or throws), but keeps the
  // compiler honest about the function's return type.
  throw lastErr;
}
