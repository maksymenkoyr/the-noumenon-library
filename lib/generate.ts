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
  // Books experiment (docs/books.md): condensed committed neighbors, passed
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
export function chooseLevers(overrides: LeverOverrides = {}): GenerationLevers {
  const model = pick(config.generationModels);
  const form = overrides.form ?? pick(GENERATION_FORMS);
  const promptVariant = overrides.promptVariant ?? DEFAULT_PROMPT_VARIANT;
  const temperature = jitteredTemperature();
  devLog(
    `generate model=${model} temp=${temperature.toFixed(2)} form="${form}" variant=${promptVariant}`,
  );
  return {
    model,
    temperature,
    promptVariant,
    form,
    prev: overrides.prev,
    next: overrides.next,
  };
}

/** A generated page plus what it cost — usage feeds the spend counter (§10). */
export interface GenerationResult {
  text: string;
  usage: GenerationUsage;
}

/** Generate the text found on a page with the given levers. */
export async function generatePage(
  levers: GenerationLevers,
): Promise<GenerationResult> {
  const prompt = buildPrompt(levers.promptVariant, {
    maxWords: config.pageMaxWords,
    form: levers.form,
    prev: levers.prev,
    next: levers.next,
  });

  const response = await getOpenRouter().chat.completions.create({
    model: levers.model,
    temperature: levers.temperature,
    max_tokens: config.maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  const tokens = response.usage?.total_tokens ?? 0;
  const pricePerMillion = config.modelPrices[levers.model] ?? 0;
  const costUsd = (tokens / 1_000_000) * pricePerMillion;

  return {
    text: response.choices[0].message.content ?? "",
    usage: { tokens, costUsd },
  };
}
