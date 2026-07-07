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

/** Like `numeric`, but allows 0 — for knobs where zero means "off". */
function nonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number`);
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

/**
 * Parse a `modelId@usdPerMillionTokens` list into a price map for the spend
 * counter (docs/architecture.md §10). `@` is the separator (model ids never
 * contain it). A model absent from the map prices at 0 — correct for the free
 * (`:free`) tier, where the cap is armed but inert until a paid model is added.
 */
function parseModelPrices(name: string): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const entry of list(name, [])) {
    const at = entry.lastIndexOf("@");
    if (at === -1) {
      throw new Error(`Invalid ${name} entry (expected model@usdPerMillion): ${entry}`);
    }
    const price = Number(entry.slice(at + 1));
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid price in ${name} entry: ${entry}`);
    }
    prices[entry.slice(0, at)] = price;
  }
  return prices;
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
  // Safety gate; on by default. Set MODERATION_ENABLED=false ONLY as a
  // temporary local unblock — the library is generate-once/store-forever, so
  // any page crystallized while this is off is persisted UNMODERATED
  // (docs/architecture.md §7).
  moderationEnabled: process.env.MODERATION_ENABLED
    ? process.env.MODERATION_ENABLED !== "false"
    : true,
  // Back-compat single generation model; the pool below supersedes it.
  model: process.env.GENERATION_MODEL ?? DEFAULT_GENERATION_MODEL,
  // Multi-model generation rotation — the "different gravity wells" variety
  // lever (docs/generation.md). A page picks one at random; logged as `model`.
  generationModels: list("GENERATION_MODELS", [
    process.env.GENERATION_MODEL ?? DEFAULT_GENERATION_MODEL,
    // TEMPORARILY DISABLED (2026-07-02) — 429ing on the free tier. Nemotron is
    // the only free model currently up. Uncomment to restore the rotation once
    // free-tier availability recovers.
    // "meta-llama/llama-3.3-70b-instruct:free",
    // "qwen/qwen3-next-80b-a3b-instruct:free",
  ]),
  // Moderation pool (free models, mixed deterministic/non) and gate policy
  // (docs/architecture.md §7).
  moderationModels: parseModerationModels("MODERATION_MODELS", [
    // TEMPORARILY the whole free moderation pool was 429ing (2026-07-02), which
    // is why moderation is also off via MODERATION_ENABLED=false. Nemotron is
    // the only free model up, so it's the lone active entry for when moderation
    // is switched back on. Uncomment the originals once availability recovers.
    "nvidia/nemotron-3-super-120b-a12b:free@0",
    // "meta-llama/llama-3.3-70b-instruct:free@0",
    // "google/gemma-4-31b-it:free@0.7",
    // "qwen/qwen3-next-80b-a3b-instruct:free@0",
  ]),
  moderationPolicy: moderationPolicy(),
  // Backstop only — the verdict is one token, but pool models may emit
  // reasoning tokens first.
  moderationMaxTokens: numeric("MODERATION_MAX_TOKENS", 2000),
  // Generation entropy levers (docs/generation.md, architecture.md §6).
  // Temperature starts coherent (the library drifts stranger over geological
  // time); Phase 9 retunes it. It is logged per page as provenance.
  temperature: numeric("GENERATION_TEMPERATURE", 0.9),
  // Per-page temperature jitter: the actual temperature is the base ± a uniform
  // draw up to this magnitude, clamped to a sane range. A model-agnostic variety
  // lever that works even when generation is pinned to a single model. 0 = off.
  temperatureJitter: nonNegative("GENERATION_TEMPERATURE_JITTER", 0.2),
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
  // Economics & safety controls (docs/architecture.md §10, Phase 6). Enforced at
  // admission control in lib/economics.ts, backed by Postgres counters.
  // Per-visitor generation rate limit (only generations count; cache hits don't).
  rateLimitPerMinute: numeric("RATE_LIMIT_PER_MINUTE", 10),
  rateLimitWindowSeconds: numeric("RATE_LIMIT_WINDOW_SECONDS", 60),
  // Monthly spend cap (USD); over the cap flips the library to explore-only.
  monthlySpendCapUsd: numeric("MONTHLY_SPEND_CAP_USD", 10),
  // Optional salt for the stored IP hash so it can't be reversed via a rainbow
  // table of the (small) address space. Empty = unsalted (still not the raw IP).
  rateLimitSalt: process.env.RATE_LIMIT_SALT ?? "",
  // Per-model price (USD per million tokens) for the spend counter. Free
  // (`:free`) models are absent → price 0, so the cap is armed but inert now.
  modelPrices: parseModelPrices("MODEL_PRICES"),
};
