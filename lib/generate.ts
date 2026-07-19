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
  GENERATION_FORMS,
} from "./prompts";
import { chooseGenerationModel, markCooling, markHealthy, markUnavailable, poolFor } from "./registry";

/**
 * Generation is a pure function of its levers plus model nondeterminism, and
 * every lever is persisted as provenance (docs/reference/architecture.md §6). The page
 * is given no address and no seed word, so the prompt is identical for every
 * page — variety comes from the model's sampling and from rotating across a
 * pool of models (the "different gravity wells" lever, docs/reference/generation.md).
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
  form: string;
  // Books experiment (docs/reference/books.md): condensed committed neighbors, passed
  // through to the prompt. Not levers proper — continuity context — but they
  // travel with the levers so regeneration retries keep the same seams.
  prev?: string;
  next?: string;
}

/**
 * Book-mode pins the form (the book's locked register) and the prompt
 * variant; model and temperature jitter stay random per attempt.
 */
export interface LeverOverrides {
  form?: string;
  promptVariant?: string;
  prev?: string;
  next?: string;
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

function isFreeSlug(slug: string): boolean {
  return slug.endsWith(":free");
}

/** Base temperature ± a uniform jitter, clamped to a valid sampling range. */
function jitteredTemperature(base: number): number {
  const offset = (Math.random() * 2 - 1) * config.temperatureJitter;
  return Math.min(2, Math.max(0.1, base + offset));
}

/**
 * Pick the entropy levers for one generation: a weighted-lottery model pick
 * (lib/registry.ts chooseGenerationModel), a random form/register for the
 * page, and a per-page jittered temperature — all logged as provenance so the
 * library's own evolution stays mappable.
 */
export async function chooseLevers(
  overrides: LeverOverrides = {},
): Promise<GenerationLevers> {
  const stats = await getModelStats();
  const chosen = await chooseGenerationModel(stats);
  const form = overrides.form ?? pick(GENERATION_FORMS);
  const promptVariant = overrides.promptVariant ?? DEFAULT_PROMPT_VARIANT;
  const temperature = jitteredTemperature(chosen.temperature);
  devLog(
    `generate model=${chosen.slug} provider=${chosen.provider} ` +
      `temp=${temperature.toFixed(2)} form="${form}" variant=${promptVariant}`,
  );
  return {
    model: chosen.slug,
    provider: chosen.provider,
    temperature,
    maxTokens: chosen.maxTokens,
    promptVariant,
    form,
    prev: overrides.prev,
    next: overrides.next,
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
 * OpenRouter slugs — the seeded pool is all-paid, so this is dormant unless a
 * `:free` model is added to model_registry later.
 */
function isAccountFreeCap(err: unknown): boolean {
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
  const prompt = buildPrompt(levers.promptVariant, {
    maxWords: config.pageMaxWords,
    form: levers.form,
    prev: levers.prev,
    next: levers.next,
  });
  // Full-prompt dev logging (docs/reference/generation.md): chooseLevers()
  // above already logs the levers; this logs the exact string sent as the
  // user message, seams and all under book-v1, for prompt iteration.
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
      const durationMs = Date.now() - startedAt;
      void recordModelCall(attempt.slug, { ms: durationMs, ok: true });
      void markHealthy(attempt.slug, "generation");

      const tokens = response.usage?.total_tokens ?? 0;
      const pricePerMillion = config.modelPrices[attempt.slug] ?? 0;
      const costUsd = (tokens / 1_000_000) * pricePerMillion;

      devLog(`generate ${attempt.slug} → ${tokens} tokens in ${durationMs}ms`);

      return {
        text: response.choices[0].message.content ?? "",
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
      } else if (isAccountFreeCap(err)) {
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
