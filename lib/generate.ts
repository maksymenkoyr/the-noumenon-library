import { config } from "./config";
import { devLog } from "./log";
import { getOpenRouter } from "./openrouter";
import { buildPrompt, DEFAULT_PROMPT_VARIANT } from "./prompts";

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
}

/**
 * Pick the entropy levers for one generation: a random model from the pool
 * (logged as provenance) at the hot generation temperature.
 */
export function chooseLevers(): GenerationLevers {
  const pool = config.generationModels;
  const model = pool[Math.floor(Math.random() * pool.length)];
  devLog(`generate model=${model} temp=${config.temperature}`);
  return {
    model,
    temperature: config.temperature,
    promptVariant: DEFAULT_PROMPT_VARIANT,
  };
}

/** Generate the text found on a page with the given levers. */
export async function generatePage(levers: GenerationLevers): Promise<string> {
  const prompt = buildPrompt(levers.promptVariant, {
    maxWords: config.pageMaxWords,
  });

  const response = await getOpenRouter().chat.completions.create({
    model: levers.model,
    temperature: levers.temperature,
    max_tokens: config.maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content ?? "";
}
