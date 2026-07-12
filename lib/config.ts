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
 * (`:free`) tier. `fallback` seeds the default paid-model prices so the spend
 * cap meters real cost out of the box, without requiring an env override.
 */
function parseModelPrices(name: string, fallback: string[] = []): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const entry of list(name, fallback)) {
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

// nvidia/nemotron-3-ultra-550b-a55b:free — strong 1M-context prose model,
// confirmed live in the OpenRouter catalog (2026-07-12). Earlier comments in
// this file claimed several free models (nemotron-3-super-120b-a12b,
// llama-3.3-70b, qwen3-next-80b, gemma-4-31b-it) were "delisted 2026-07-11";
// re-verified against the live /models endpoint on 2026-07-12 and that was
// wrong — all four are still in the catalog. The actual recurring failure is
// OpenRouter's account-wide `free-models-per-day` cap (50 requests/day without
// credits), which 429s every `:free` model at once — cycling the free pool
// doesn't help that, only a paid fallback does (see paidGenerationModels
// below and lib/generate.ts's free-tier cooldown short-circuit).
const DEFAULT_GENERATION_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

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
  // Free generation pool — the "different gravity wells" variety lever
  // (docs/generation.md), and the cost-minimizing default: pages are served
  // from here whenever possible. chooseLevers() (lib/generate.ts) picks a
  // primary member latency-weighted (via model_stats) so slow pool members
  // are naturally down-weighted; generatePage() falls back through the rest
  // of the pool on a retryable error (429 / 5xx / connection failure). When
  // the OpenRouter account-wide free-cap 429 trips, selection short-circuits
  // straight to paidGenerationModels below instead of cycling this pool.
  generationModels: list("GENERATION_MODELS", [
    process.env.GENERATION_MODEL ?? DEFAULT_GENERATION_MODEL,
    "nvidia/nemotron-3-super-120b-a12b:free",
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "meta-llama/llama-3.3-70b-instruct:free",
    "tencent/hy3:free",
  ]),
  // Paid safety net for generation: the fallback tail once the free pool is
  // exhausted or the account-wide free-cap cooldown is active (§ above).
  // Defaults to the cheapest strong-prose tier on OpenRouter (verified
  // 2026-07-12): ~$0.10-0.15 per million tokens, ~$0.0006/page. Step up to a
  // pricier tier by overriding this env var — no code change needed.
  paidGenerationModels: list("PAID_GENERATION_MODELS", [
    "deepseek/deepseek-v4-flash",
    "qwen/qwen3-235b-a22b-2507",
  ]),
  // Moderation pool (free models, mixed deterministic/non) and gate policy
  // (docs/architecture.md §7). Fan-out is parallel (lib/moderate.ts), so a
  // model erroring or 429ing just abstains rather than failing the request —
  // no retry loop needed here, unlike generation. Dedicated safety classifier
  // first, general models as backup voters.
  moderationModels: parseModerationModels("MODERATION_MODELS", [
    "nvidia/nemotron-3.5-content-safety:free@0",
    "nvidia/nemotron-3-ultra-550b-a55b:free@0",
    "meta-llama/llama-3.3-70b-instruct:free@0",
    "qwen/qwen3-next-80b-a3b-instruct:free@0",
    "tencent/hy3:free@0",
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
  // Books experiment (docs/books.md): volume = book — locked form per volume,
  // neighbor continuity via condensed prev/next in the prompt (variant
  // 'book-v1'). Default off; BOOK_MODE=false is a full kill switch back to
  // isolated base-v2 generation (existing book rows are simply ignored).
  bookMode: process.env.BOOK_MODE === "true",
  // Condensation shape (the reverse bell curve): first/last sentences are kept
  // verbatim; only the middle is summarized, to at most this many words…
  condensedMiddleMaxWords: numeric("CONDENSED_MIDDLE_MAX_WORDS", 60),
  // …and a middle already shorter than this is kept as-is (no LLM call).
  condenseMinMiddleWords: numeric("CONDENSE_MIN_MIDDLE_WORDS", 60),
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
  // Reader-signal write throttle (docs/architecture.md §8, Phase 10). Likes and
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
  // Per-model price (USD per million tokens) for the spend counter. Free
  // (`:free`) models are absent → price 0. paidGenerationModels are priced by
  // default so the $MONTHLY_SPEND_CAP_USD cap meters real spend the moment
  // the paid safety net fires, with no env setup required. Prices are a
  // single blended in/out rate (input:output ≈ 1:4, generation is output-
  // heavy) rounded up slightly — conservative is safer than undercounting.
  modelPrices: parseModelPrices("MODEL_PRICES", [
    "deepseek/deepseek-v4-flash@0.15",
    "qwen/qwen3-235b-a22b-2507@0.1",
  ]),
  // Optional alert webhook (Discord/Slack-compatible) for monitor() events —
  // generation/moderation/DB failures (docs/architecture.md §9, Phase 7). Unset
  // → structured JSON logs only, no push. Never let alerting break a request.
  monitorWebhookUrl: process.env.MONITOR_WEBHOOK_URL ?? "",
  // Contact address for abuse/copyright reports, shown on /about and beside the
  // on-page report control (docs/legal.md, Phase 9) as the manual channel.
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
