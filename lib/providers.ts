import OpenAI from "openai";
import { config } from "./config";

/**
 * Provider abstraction (docs/reference/architecture.md §6, model-pool rework). Both
 * providers speak the OpenAI-compatible chat-completions API, so one SDK
 * serves both — only the baseURL and key differ, keyed off `model_registry
 * .provider` (lib/registry.ts). A provider whose key is unset is simply left
 * out of selection rather than crashing the app: cache hits must keep being
 * served even with zero providers configured.
 */
export type Provider = "openrouter" | "google";

const BASE_URLS: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  // Google's OpenAI-compatible endpoint (trailing slash required by their SDK
  // shim — the client appends "chat/completions" etc. onto it directly).
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
};

function apiKeyFor(provider: Provider): string {
  return provider === "openrouter" ? config.openrouterApiKey : config.googleApiKey;
}

const clients = new Map<Provider, OpenAI>();
const warnedMissing = new Set<Provider>();

/**
 * Whether a provider's models can currently be selected — its API key is
 * set. Logs once per process (not once per call) so a genuinely unconfigured
 * provider doesn't spam the log on every generation.
 */
export function providerAvailable(provider: Provider): boolean {
  const available = apiKeyFor(provider).length > 0;
  if (!available && !warnedMissing.has(provider)) {
    warnedMissing.add(provider);
    console.warn(
      `[noumenon] ⚠ ${provider} API key not set — its models are unavailable`,
    );
  }
  return available;
}

/**
 * Cached OpenAI-compatible client for a provider, or undefined if its key is
 * unset. Never throws — a missing key degrades to "provider unavailable" via
 * lib/registry.ts's poolFor, not a crash.
 */
export function getClient(provider: Provider): OpenAI | undefined {
  if (!providerAvailable(provider)) return undefined;
  let client = clients.get(provider);
  if (!client) {
    client = new OpenAI({
      baseURL: BASE_URLS[provider],
      apiKey: apiKeyFor(provider),
    });
    clients.set(provider, client);
  }
  return client;
}

/**
 * Reasoning is off for every call (docs/reference/generation.md, model-pool rework §4)
 * — reasoning tokens are pure cost and latency for a page of prose; they're
 * the whole reason GENERATION_MAX_TOKENS used to need to be 4000 and
 * STALE_RESERVATION_SECONDS 300. The two providers spell "off" differently:
 * OpenRouter has a unified top-level `reasoning` request field; Google's
 * OpenAI-compat endpoint takes a top-level `reasoning_effort`. Neither is part
 * of the official OpenAI SDK types, but both travel fine as extra top-level
 * keys spread into chat.completions.create — the SDK serializes unknown keys
 * verbatim. Do NOT wrap either in `extra_body`: that's an OpenAI *Python* SDK
 * convention (Python unpacks it into the request body); the TS SDK has no
 * such feature, so `extra_body` would ship as a literal top-level field and
 * Google's gateway rejects it with a bodyless 400. Spread the result into
 * every chat.completions.create call — unconditionally, not gated on the
 * model_registry.reasoning_enabled column (that column documents the setting
 * on the row; enforcement is this one code path, so it can never drift
 * per-model).
 */
export function reasoningParams(provider: Provider): Record<string, unknown> {
  if (provider === "google") {
    return { reasoning_effort: "none" };
  }
  return { reasoning: { enabled: false } };
}

/** HTTP status of an API error, if it is one — undefined for e.g. a raw connection error. */
export function errorStatus(err: unknown): number | undefined {
  return err instanceof OpenAI.APIError ? err.status : undefined;
}

const BASE_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 15 * 60;

/**
 * Seconds to cool a model down after a 429 (docs/reference/architecture.md §7 of the
 * model-pool rework — "honour Retry-After ... where the provider sends them;
 * otherwise capped exponential backoff"). `attempt` is an optional hint from
 * the caller (0-indexed count of consecutive failures it has already seen for
 * this model within the current request) — omitted, it's just the base
 * cooldown; this does not persist escalation across separate requests, only
 * within one caller's own retry loop.
 */
export function cooldownSeconds(err: unknown, attempt = 0): number {
  if (err instanceof OpenAI.APIError) {
    const retryAfter = err.headers?.get?.("retry-after");
    if (retryAfter) {
      const asSeconds = Number(retryAfter);
      if (Number.isFinite(asSeconds) && asSeconds > 0) return asSeconds;
      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) {
        const seconds = Math.round((asDate - Date.now()) / 1000);
        if (seconds > 0) return seconds;
      }
    }
  }
  return Math.min(MAX_COOLDOWN_SECONDS, BASE_COOLDOWN_SECONDS * 2 ** attempt);
}
