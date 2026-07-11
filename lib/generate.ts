import OpenAI from "openai";
import { config } from "./config";
import type { GenerationUsage } from "./economics";
import { devLog } from "./log";
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

/** Base temperature ± a uniform jitter, clamped to a valid sampling range. */
function jitteredTemperature(): number {
  const offset = (Math.random() * 2 - 1) * config.temperatureJitter;
  return Math.min(2, Math.max(0.1, config.temperature + offset));
}

/**
 * Pick the entropy levers for one generation: a random model from the pool, a
 * random form/register for the page, and a per-page jittered temperature — all
 * logged as provenance so the library's own evolution stays mappable.
 */
export function chooseLevers(): GenerationLevers {
  const model = pick(config.generationModels);
  const form = pick(GENERATION_FORMS);
  const temperature = jitteredTemperature();
  devLog(
    `generate model=${model} temp=${temperature.toFixed(2)} form="${form}"`,
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
 * first, then falls back through the rest of the pool (shuffled) on a
 * retryable error — the "different gravity wells" variety lever doubling as
 * availability fallback. A non-retryable error (bad request, bad key, ...)
 * rethrows immediately since no other model would fix it.
 */
export async function generatePage(
  levers: GenerationLevers,
): Promise<GenerationResult> {
  const prompt = buildPrompt(levers.promptVariant, {
    maxWords: config.pageMaxWords,
    form: levers.form,
  });

  const rest = shuffled(
    config.generationModels.filter((m) => m !== levers.model),
  );
  const attempts = [levers.model, ...rest];

  let lastErr: unknown;
  for (const [i, model] of attempts.entries()) {
    try {
      const response = await getOpenRouter().chat.completions.create({
        model,
        temperature: levers.temperature,
        max_tokens: config.maxTokens,
        messages: [{ role: "user", content: prompt }],
      });

      const tokens = response.usage?.total_tokens ?? 0;
      const pricePerMillion = config.modelPrices[model] ?? 0;
      const costUsd = (tokens / 1_000_000) * pricePerMillion;

      return {
        text: response.choices[0].message.content ?? "",
        model,
        usage: { tokens, costUsd },
      };
    } catch (err) {
      lastErr = err;
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
