import OpenAI from "openai";
import { config } from "./config";
import type { GenerationUsage } from "./economics";
import { devLog } from "./log";
import {
  FREE_TIER_KEY,
  freeTierOnCooldown,
  getModelStats,
  markRateLimited,
  recordModelCall,
} from "./modelStats";
import {
  cooldownSeconds,
  errorStatus,
  getClient,
  reasoningParams,
  type Provider,
} from "./providers";
import {
  buildPrompt,
  DEFAULT_PROMPT_VARIANT,
  GENERATION_CONSTRAINTS,
  type PromptConstraint,
} from "./prompts";
import { chooseGenerationModel, markCooling, markHealthy, markUnavailable, poolFor } from "./registry";
import { attemptSeed, makeSeededRandom } from "./seededRandom";

/**
 * Generation is a pure function of its levers plus model nondeterminism, and
 * every lever is persisted as provenance (docs/reference/architecture.md §6).
 * The prompt carries no address — lever *selection* is seeded by the address
 * (lib/seededRandom.ts) so the page reproduces from its coordinate, while
 * prompt-side variety comes from the sampled constraint slot
 * (GENERATION_CONSTRAINTS) and from rotating across a pool of models (the
 * "different gravity wells" lever, docs/reference/generation.md).
 * Model selection itself lives in lib/registry.ts (model_registry, weighted
 * lottery); this module owns the levers, the prompt call, and per-request
 * fallback across the rest of the eligible pool on a retryable error.
 */
export interface GenerationLevers {
  model: string; // provider's model slug
  provider: Provider;
  temperature: number; // jittered around the chosen row's base temperature
  maxTokens: number; // the chosen row's max_tokens
  promptVariant: string;
  // Dynamic constraints sampled for this page. Their ids ride into
  // provenance via provenanceVariant().
  constraints: readonly PromptConstraint[];
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

function isFreeSlug(slug: string): boolean {
  return slug.endsWith(":free");
}

/** Base temperature ± a uniform jitter, clamped to a valid sampling range. */
function jitteredTemperature(base: number, rng: () => number): number {
  const offset = (rng() * 2 - 1) * config.temperatureJitter;
  return Math.min(2, Math.max(0.1, base + offset));
}

/** Each pool constraint applies independently, by its own probability. */
function sampleConstraints(rng: () => number): PromptConstraint[] {
  return GENERATION_CONSTRAINTS.filter((c) => rng() < c.probability);
}

/**
 * The prompt_variant value persisted for a generation: the variant id plus a
 * `+id` suffix per applied constraint (e.g. `base-v1+no-library`), so the
 * constraint dial stays attributable in wander reports and SQL without a
 * schema change. Only ever diverges from levers.promptVariant when a
 * constraint fired.
 */
export function provenanceVariant(levers: GenerationLevers): string {
  const suffix = levers.constraints.map((c) => `+${c.id}`).join("");
  return levers.promptVariant + suffix;
}

/**
 * Pick the entropy levers for one generation. Every draw comes from a PRNG
 * seeded by the page's address (lib/seededRandom.ts), so the levers — and thus
 * the page — are a reproducible function of the coordinate: the same address
 * always crystallizes the same page (docs/reference/generation.md). A
 * moderation- or dedup-regeneration passes a higher `attempt`, folding it into
 * the seed so the retry deterministically draws a *different* sample instead
 * of repeating the one that was rejected or collided.
 *
 * Levers drawn from the seeded stream: the weighted-lottery model pick
 * (lib/registry.ts chooseGenerationModel), the per-page temperature jitter,
 * and the constraint sample. All of it is logged as provenance so the
 * library's evolution stays mappable.
 */
export async function chooseLevers(
  address: string,
  attempt = 0,
): Promise<GenerationLevers> {
  const rng = makeSeededRandom(attemptSeed(address, attempt));
  const stats = await getModelStats();
  const chosen = await chooseGenerationModel(stats, rng);
  const promptVariant = DEFAULT_PROMPT_VARIANT;
  // Fixed draw order (model above, then constraints, then temperature) so a
  // given seed always maps to the same page.
  const constraints = sampleConstraints(rng);
  const temperature = jitteredTemperature(chosen.temperature, rng);
  devLog(
    `generate address=${address} attempt=${attempt} model=${chosen.slug} ` +
      `provider=${chosen.provider} temp=${temperature.toFixed(2)} ` +
      `variant=${promptVariant}` +
      (constraints.length
        ? ` constraints=${constraints.map((c) => c.id).join(",")}`
        : ""),
  );
  return {
    model: chosen.slug,
    provider: chosen.provider,
    temperature,
    maxTokens: chosen.maxTokens,
    promptVariant,
    constraints,
  };
}

/**
 * A generated page plus what it cost — usage feeds the spend counter (§10).
 * `model`/`provider` are the pool member that actually answered, which may
 * differ from what chooseLevers() picked if earlier pool members were
 * skipped on a retryable error — callers should treat this as the true
 * provenance.
 */
export interface GenerationResult {
  text: string;
  model: string;
  provider: Provider;
  usage: GenerationUsage;
  // The exact assembled prompt this generation sent as its user message —
  // dev-overlay provenance (lib/devMode, app/[[...address]]/dev-badge), not
  // persisted. Identical across every fallback attempt in one call (only the
  // model/provider vary), so it's safe to surface once per result.
  prompt: string;
  // Wall time of the one attempt that actually answered — excludes any
  // earlier failed fallback attempts, so this is generation time proper, not
  // padded by retries against dead models.
  durationMs: number;
}

/** Whether a failed call is worth retrying on a different pool model. */
function shouldFallback(err: unknown): boolean {
  const status = errorStatus(err);
  return status === undefined || status === 404 || status === 429 || status >= 500;
}

/**
 * Whether a 429 is OpenRouter's account-wide `free-models-per-day` cap (50
 * requests/day without credits) rather than an ordinary per-model rate
 * limit. This flavor caps every `:free` model at once, so — unlike a normal
 * 429 — cycling the rest of the free pool doesn't help. Detected primarily by
 * message text; the `x-ratelimit-remaining: 0` header is a fallback for cases
 * where the message wording drifts. Only ever relevant to `:free`-suffixed
 * OpenRouter slugs, so the attempt is checked first — an ordinary paid-model
 * 429 also commonly carries `x-ratelimit-remaining: 0`, and must not park
 * the whole free tier. The seeded pool is all-paid, so this is dormant
 * unless a `:free` model is added to model_registry later.
 */
function isAccountFreeCap(err: unknown, attempt: Attempt): boolean {
  if (attempt.provider !== "openrouter" || !isFreeSlug(attempt.slug)) return false;
  if (!(err instanceof OpenAI.APIError) || err.status !== 429) return false;
  if (err.message?.toLowerCase().includes("free-models-per-day")) return true;
  return err.headers?.get?.("x-ratelimit-remaining") === "0";
}

const ACCOUNT_FREE_CAP_COOLDOWN_SECONDS = 15 * 60;

interface Attempt {
  slug: string;
  provider: Provider;
  maxTokens: number;
}

/**
 * Generate the text found on a page with the given levers. Models
 * intermittently 429, 404 (delisted), or fail transiently, so this tries the
 * chosen model first, then falls back through the rest of the eligible pool
 * (shuffled) on a retryable error — the "different gravity wells" variety
 * lever doubling as availability fallback. A non-retryable error (bad
 * request, bad auth, ...) rethrows immediately since no other model would
 * fix it.
 *
 * Every attempt's outcome (success/failure, duration) is recorded to
 * model_stats fire-and-forget, and health transitions land on the model's
 * model_registry row (lib/registry.ts): a 429 parks it `cooling` until the
 * backoff window passes (lazy recovery, no probe cron); a 404 marks it
 * `unavailable` permanently. If OpenRouter's account-wide free-cap 429 is
 * detected, the remaining free attempts are dropped — cycling the capped
 * free tier further would just burn requests for the same error.
 */
export async function generatePage(
  levers: GenerationLevers,
): Promise<GenerationResult> {
  const constraintTexts = levers.constraints.map((c) => c.text);
  const prompt = buildPrompt(levers.promptVariant, {
    maxWords: config.pageMaxWords,
    constraints: constraintTexts,
  });
  // Full-prompt dev logging (docs/reference/generation.md): chooseLevers()
  // above already logs the levers; this logs the exact string sent as the
  // user message, for prompt iteration.
  devLog(`generate prompt variant=${levers.promptVariant}\n${prompt}`);

  const [stats, pool] = await Promise.all([getModelStats(), poolFor("generation")]);
  const freeCapActive = freeTierOnCooldown(stats);
  const rest: Attempt[] = shuffled(
    pool
      .filter((row) => !(row.slug === levers.model && row.provider === levers.provider))
      .filter(
        (row) => !(freeCapActive && row.provider === "openrouter" && isFreeSlug(row.slug)),
      ),
  ).map((row) => ({ slug: row.slug, provider: row.provider, maxTokens: row.maxTokens }));

  let attempts: Attempt[] = [
    { slug: levers.model, provider: levers.provider, maxTokens: levers.maxTokens },
    ...rest,
  ];

  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const client = getClient(attempt.provider);
    if (!client) {
      // Shouldn't happen — poolFor() already filters to providers with a
      // configured key — but stay defensive rather than crash the request.
      lastErr = new Error(`No client for provider: ${attempt.provider}`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const response = await client.chat.completions.create({
        model: attempt.slug,
        temperature: levers.temperature,
        max_tokens: attempt.maxTokens,
        messages: [{ role: "user", content: prompt }],
        ...reasoningParams(attempt.provider),
      });
      const text = response.choices[0]?.message.content ?? "";
      const durationMs = Date.now() - startedAt;
      if (!text.trim()) {
        // An empty completion (truncation, upstream filtering, a glitching
        // model) must never crystallize: generate-once/store-forever would
        // make the blank page permanent. Treat it like any other retryable
        // model failure and fall through the rest of the pool.
        void recordModelCall(attempt.slug, { ms: durationMs, ok: false });
        lastErr = new Error(`Empty completion from ${attempt.slug}`);
        if (i === attempts.length - 1) throw lastErr;
        devLog(`generate model=${attempt.slug} returned an empty completion → falling back`);
        continue;
      }
      void recordModelCall(attempt.slug, { ms: durationMs, ok: true });
      void markHealthy(attempt.slug, "generation");

      const tokens = response.usage?.total_tokens ?? 0;
      const pricePerMillion = config.modelPrices[attempt.slug] ?? 0;
      const costUsd = (tokens / 1_000_000) * pricePerMillion;

      devLog(`generate ${attempt.slug} → ${tokens} tokens in ${durationMs}ms`);

      return {
        text,
        model: attempt.slug,
        provider: attempt.provider,
        usage: { tokens, costUsd },
        prompt,
        durationMs,
      };
    } catch (err) {
      void recordModelCall(attempt.slug, { ms: Date.now() - startedAt, ok: false });
      lastErr = err;

      const status = errorStatus(err);
      if (status === 404) {
        void markUnavailable(attempt.slug, "generation");
      } else if (isAccountFreeCap(err, attempt)) {
        void markRateLimited(FREE_TIER_KEY, ACCOUNT_FREE_CAP_COOLDOWN_SECONDS);
        // The whole free tier is capped for the day — drop any remaining
        // free attempts so the loop jumps straight to the paid tail instead
        // of burning requests on the same account-wide 429.
        attempts = attempts.slice(0, i + 1).concat(
          attempts
            .slice(i + 1)
            .filter((a) => !(a.provider === "openrouter" && isFreeSlug(a.slug))),
        );
      } else if (status === 429 || status === undefined || status >= 500) {
        void markCooling(
          attempt.slug,
          "generation",
          new Date(Date.now() + cooldownSeconds(err) * 1000),
        );
      }

      if (!shouldFallback(err) || i === attempts.length - 1) throw err;
      devLog(
        `generate model=${attempt.slug} failed (${
          err instanceof Error ? err.message : String(err)
        }) → falling back to next pool model`,
      );
    }
  }

  // Unreachable (the loop above always returns or throws), but keeps the
  // compiler honest about the function's return type.
  throw lastErr;
}
