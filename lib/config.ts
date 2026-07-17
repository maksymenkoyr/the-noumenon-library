/**
 * Centralized env-var configuration — the single home for tunables
 * (docs/reference/architecture.md §11). Required vars are read lazily so a missing
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
    throw new Error(
      `Environment variable ${name} must be a non-negative number`,
    );
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

/**
 * Parse a `modelId@usdPerMillionTokens` list into a price map for the spend
 * counter (docs/reference/architecture.md §10). `@` is the separator (model ids never
 * contain it). A model absent from the map prices at 0 — correct for Google's
 * free-tier models. `fallback` seeds the default paid-model prices (the
 * model_registry seed's paid rows, lib/schema.sql) so the spend cap meters
 * real cost out of the box, without requiring an env override.
 *
 * TODO(model-pool follow-up): this map is hand-maintained and will silently
 * under-report if a model is repriced upstream or loses a free tag — live
 * catalog pricing is a separate, not-yet-built task.
 */
function parseModelPrices(
  name: string,
  fallback: string[] = [],
): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const entry of list(name, fallback)) {
    const at = entry.lastIndexOf("@");
    if (at === -1) {
      throw new Error(
        `Invalid ${name} entry (expected model@usdPerMillion): ${entry}`,
      );
    }
    const price = Number(entry.slice(at + 1));
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid price in ${name} entry: ${entry}`);
    }
    prices[entry.slice(0, at)] = price;
  }
  return prices;
}

// Default prices for the paid rows seeded into model_registry (lib/schema.sql)
// — single blended $/M-output-tokens figures, verified against OpenRouter's
// live /api/v1/models catalog (2026-07-12). Google's free-tier models
// (Gemini 3 Flash, Gemini 3.1 Flash-Lite) are intentionally absent → price 0.
const DEFAULT_MODEL_PRICES = [
  "deepseek/deepseek-v4-flash@0.15",
  "moonshotai/kimi-k2.6@3.41",
  "z-ai/glm-5.2@1.32",
  "anthropic/claude-haiku-4.5@5.00",
  "mistralai/mistral-large-2512@1.50",
  "anthropic/claude-sonnet-5@10.00",
  "anthropic/claude-opus-4.8@25.00",
];

export const config = {
  // Provider keys (docs/reference/architecture.md §6, lib/providers.ts). Both are
  // server-only and optional at the config layer: a provider with no key set
  // simply has its model_registry rows filtered out of selection (lib/
  // registry.ts poolFor) rather than crashing the app — cache hits must keep
  // being served with zero providers configured. Never NEXT_PUBLIC_*.
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  googleApiKey: process.env.GOOGLE_API_KEY ?? "",
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
  // (docs/reference/architecture.md §7).
  moderationEnabled: process.env.MODERATION_ENABLED
    ? process.env.MODERATION_ENABLED  === "true"
    : true,
  // Generation entropy levers (docs/reference/generation.md, architecture.md §6).
  // Temperature starts coherent (the library drifts stranger over geological
  // time); Phase 9 retunes it. It is logged per page as provenance.
  temperature: numeric("GENERATION_TEMPERATURE", 0.9),
  // Per-page temperature jitter: the actual temperature is the base ± a uniform
  // draw up to this magnitude, clamped to a sane range. A model-agnostic variety
  // lever that works even when generation is pinned to a single model. 0 = off.
  temperatureJitter: nonNegative("GENERATION_TEMPERATURE_JITTER", 0.2),
  // Page-size constraint (docs/reference/generation.md). pageMaxWords is the real size
  // control, stated in the prompt; maxTokens is a cost backstop for the aux
  // generation-pool calls that don't have their own model_registry row (book
  // title/tags, condensation — lib/book.ts, lib/condense.ts). The real
  // per-call cap for generation/moderation proper comes from the chosen
  // model_registry row's max_tokens (lib/registry.ts). Lowered 4000 → 1000
  // now that reasoning is off on every call (§4 of the model-pool rework) —
  // reasoning tokens no longer eat the budget before any page text.
  pageMaxWords: numeric("PAGE_MAX_WORDS", 400),
  maxTokens: numeric("GENERATION_MAX_TOKENS", 1000),
  // Books experiment (docs/reference/books.md): volume = book — locked form per volume,
  // neighbor continuity via condensed prev/next in the prompt (variant
  // 'book-v1'). Default off; BOOK_MODE=false is a full kill switch back to
  // isolated base-v2 generation (existing book rows are simply ignored).
  bookMode: process.env.BOOK_MODE === "true",
  // Condensation shape (the reverse bell curve): first/last sentences are kept
  // verbatim; only the middle is summarized, to at most this many words…
  condensedMiddleMaxWords: numeric("CONDENSED_MIDDLE_MAX_WORDS", 60),
  // …and a middle already shorter than this is kept as-is (no LLM call).
  condenseMinMiddleWords: numeric("CONDENSE_MIN_MIDDLE_WORDS", 60),
  // Concurrency guard tunables (docs/reference/architecture.md §3). The stale window
  // must comfortably exceed worst-case generation time. Lowered 300 → 90 now
  // that reasoning is off on every call (§4 of the model-pool rework) — the
  // old default accounted for a reasoning model's long blank-pause latency,
  // which no longer applies.
  staleReservationSeconds: numeric("STALE_RESERVATION_SECONDS", 90),
  generationWaitSeconds: numeric("GENERATION_WAIT_SECONDS", 300),
  waitPollIntervalMs: numeric("WAIT_POLL_INTERVAL_MS", 750),
  // Economics & safety controls (docs/reference/architecture.md §10, Phase 6). Enforced at
  // admission control in lib/economics.ts, backed by Postgres counters.
  // Per-visitor generation rate limit (only generations count; cache hits don't).
  rateLimitPerMinute: numeric("RATE_LIMIT_PER_MINUTE", 10),
  rateLimitWindowSeconds: numeric("RATE_LIMIT_WINDOW_SECONDS", 60),
  // Monthly spend cap (USD); over the cap flips the library to explore-only.
  monthlySpendCapUsd: numeric("MONTHLY_SPEND_CAP_USD", 10),
  // Reader-signal write throttle (docs/reference/architecture.md §8, Phase 10). Likes and
  // dwell beacons are cheap DB writes (no LLM), so the ceiling is generous —
  // it only blunts trivial gaming of the aggregate count / event flooding. Keyed
  // by hashed IP over a sliding window, same as the generation rate limit.
  engagementRateLimitPerMinute: numeric("ENGAGEMENT_RATE_LIMIT_PER_MINUTE", 60),
  engagementRateLimitWindowSeconds: numeric(
    "ENGAGEMENT_RATE_LIMIT_WINDOW_SECONDS",
    60,
  ),
  // Optional salt for the stored IP hash so it can't be reversed via a rainbow
  // table of the (small) address space. Empty = unsalted (still not the raw IP).
  rateLimitSalt: process.env.RATE_LIMIT_SALT ?? "",
  // Per-model price (USD per million tokens) for the spend counter — see
  // DEFAULT_MODEL_PRICES above for the interim-pricing rationale and TODO.
  modelPrices: parseModelPrices("MODEL_PRICES", DEFAULT_MODEL_PRICES),
  // Optional alert webhook (Discord/Slack-compatible) for monitor() events —
  // generation/moderation/DB failures (docs/reference/architecture.md §9, Phase 7). Unset
  // → structured JSON logs only, no push. Never let alerting break a request.
  monitorWebhookUrl: process.env.MONITOR_WEBHOOK_URL ?? "",
  // Contact address for abuse/copyright reports, shown on /about and beside the
  // on-page report control (docs/reference/legal.md, Phase 9) as the manual channel.
  // Unset → the about page says reporting is temporarily offline.
  reportContactEmail: process.env.REPORT_CONTACT_EMAIL ?? "",
  // Operator notification for on-page reports (lib/reportEmail.ts): one Resend
  // API call per newly-reported page, fail-open. All three unset by default —
  // reports still land in page_reports and /operator, just without the push.
  // The from-address domain must be verified in Resend for production sends;
  // the resend.dev default only works for sends to the account owner.
  get resendApiKey() {
    return process.env.RESEND_API_KEY ?? "";
  },
  get reportNotifyEmail() {
    return process.env.REPORT_NOTIFY_EMAIL ?? "";
  },
  get reportFromEmail() {
    return process.env.REPORT_FROM_EMAIL ?? "reports@resend.dev";
  },
  // True only in a real production deploy — gates the fail-closed moderation
  // guard (lib/moderate.ts): never store unmoderated content in production.
  isProduction: process.env.NODE_ENV === "production",
  // TEMPORARY private-share escape: when true, the production fail-closed
  // moderation guard is deliberately relaxed so pages can crystallize while
  // MODERATION_ENABLED=false. Must be UNSET before any genuinely public launch.
  allowUnmoderated: process.env.ALLOW_UNMODERATED === "true",
  // Private-access gate (proxy.ts + app/api/access, lib/access.ts). When set,
  // the whole site is gated behind reusable invite links (scripts/invite.mjs)
  // that redeem into an HMAC-signed session cookie. Unset (local
  // dev, or an intentionally public deploy) => gate is inert, site is open.
  accessSigningSecret: process.env.ACCESS_SIGNING_SECRET ?? "",
};
