/**
 * Centralized env-var configuration — the single home for tunables
 * (docs/architecture.md §11). Required vars are read lazily so a missing
 * one only fails at call time, not at import time.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function numeric(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number`);
  }
  return value;
}

/** Parse a comma-separated env list into trimmed, non-empty entries. */
function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

export interface ModerationModel {
  model: string;
  temperature: number;
}

/**
 * Parse a moderation-pool list of `modelId@temp` entries. `@` is the separator
 * because model ids contain `:` and `/` but never `@`; a missing `@temp` means
 * deterministic (temp 0). This is the "multiple free models, deterministic and
 * non" pool (docs/architecture.md §7).
 */
function parseModerationModels(
  name: string,
  fallback: string[],
): ModerationModel[] {
  return list(name, fallback).map((entry) => {
    const at = entry.lastIndexOf("@");
    if (at === -1) return { model: entry, temperature: 0 };
    const temp = Number(entry.slice(at + 1));
    if (!Number.isFinite(temp) || temp < 0) {
      throw new Error(`Invalid temperature in ${name} entry: ${entry}`);
    }
    return { model: entry.slice(0, at), temperature: temp };
  });
}

const DEFAULT_GENERATION_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

export type ModerationPolicy = "any-fail" | "majority" | "unanimous-fail";

function moderationPolicy(): ModerationPolicy {
  const raw = process.env.MODERATION_POLICY ?? "any-fail";
  if (raw !== "any-fail" && raw !== "majority" && raw !== "unanimous-fail") {
    throw new Error(
      `MODERATION_POLICY must be any-fail | majority | unanimous-fail, got: ${raw}`,
    );
  }
  return raw;
}

export const config = {
  get openrouterApiKey() {
    return required("OPENROUTER_API_KEY");
  },
  get databaseUrl() {
    return required("DATABASE_URL");
  },
  // Dev mode: console-log which model each call runs. On by default outside
  // production (so `next dev` shows it); DEV_MODE overrides either way.
  devMode: process.env.DEV_MODE
    ? process.env.DEV_MODE === "true"
    : process.env.NODE_ENV !== "production",
  // Back-compat single generation model; the pool below supersedes it.
  model: process.env.GENERATION_MODEL ?? DEFAULT_GENERATION_MODEL,
  // Multi-model generation rotation — the "different gravity wells" variety
  // lever (docs/generation.md). A page picks one at random; logged as `model`.
  generationModels: list("GENERATION_MODELS", [
    process.env.GENERATION_MODEL ?? DEFAULT_GENERATION_MODEL,
    "meta-llama/llama-3.3-70b-instruct:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
  ]),
  // Moderation pool (free models, mixed deterministic/non) and gate policy
  // (docs/architecture.md §7).
  moderationModels: parseModerationModels("MODERATION_MODELS", [
    "meta-llama/llama-3.3-70b-instruct:free@0",
    "google/gemma-4-31b-it:free@0.7",
    "qwen/qwen3-next-80b-a3b-instruct:free@0",
  ]),
  moderationPolicy: moderationPolicy(),
  // Backstop only — the verdict is one token, but pool models may emit
  // reasoning tokens first.
  moderationMaxTokens: numeric("MODERATION_MAX_TOKENS", 2000),
  // Generation entropy levers (docs/generation.md, architecture.md §6).
  // Temperature starts coherent (the library drifts stranger over geological
  // time); Phase 9 retunes it. It is logged per page as provenance.
  temperature: numeric("GENERATION_TEMPERATURE", 0.9),
  // Page-size constraint (docs/generation.md). pageMaxWords is the real size
  // control, stated in the prompt; maxTokens is only a cost backstop and is
  // deliberately generous — the :free nemotron is a reasoning model whose
  // reasoning tokens count against the budget, so a tight cap would starve
  // (and visibly truncate) the page.
  pageMaxWords: numeric("PAGE_MAX_WORDS", 400),
  maxTokens: numeric("GENERATION_MAX_TOKENS", 4000),
  // Concurrency guard tunables (docs/architecture.md §3). The stale window
  // must comfortably exceed worst-case generation time — the current :free
  // reasoning model can take minutes; tighten when the model tier improves.
  staleReservationSeconds: numeric("STALE_RESERVATION_SECONDS", 300),
  generationWaitSeconds: numeric("GENERATION_WAIT_SECONDS", 300),
  waitPollIntervalMs: numeric("WAIT_POLL_INTERVAL_MS", 750),
};
