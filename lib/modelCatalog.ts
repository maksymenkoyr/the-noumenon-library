/**
 * Live provider catalogs and OpenRouter's usage rankings — the outside-world
 * inputs to the daily model-pool review (lib/modelReview.ts,
 * scripts/review-models.ts).
 *
 * This module is deliberately I/O-only and dependency-free: it fetches, parses,
 * and normalises, and makes no decisions. Everything that decides lives in
 * lib/modelReview.ts, which is pure and unit-tested without a network. Keeping
 * the split sharp is what lets the whole review engine be tested offline.
 *
 * It also has NO runtime imports on purpose. scripts/review-models.ts runs
 * under Node's native type stripping with no build step, and type-only imports
 * are erased before Node ever resolves them — so this file stays loadable
 * as-is. Don't add a value import from another lib/ module here.
 */

export type CatalogProvider = "openrouter" | "google";

/** One model as the provider describes it today, normalised across providers. */
export interface CatalogModel {
  /** The id to put in a model_registry row and send as `model` on a request. */
  slug: string;
  /**
   * OpenRouter's stable, version-dated identity for the same model
   * (`anthropic/claude-4.5-haiku-20251001`). This — not `slug` — is the join
   * key to the rankings feed. Absent for Google, which has no such concept.
   */
  canonicalSlug?: string;
  provider: CatalogProvider;
  name: string;
  description: string;
  /**
   * $/M tokens, completion side. A single blended output-token figure is what
   * the spend counter has always metered in (lib/economics.ts), so this stays
   * comparable to the numbers MODEL_PRICES used to carry.
   */
  pricePerMillion: number;
  /** $/M tokens, prompt side — reported in the digest so a swap is legible. */
  promptPricePerMillion: number;
  contextLength: number;
  /** e.g. `text->text`. Anything else is not a prose model. */
  modality: string;
  outputModalities: string[];
  /** OpenRouter's `supported_parameters`; empty for Google (not reported). */
  supportedParameters: string[];
  /** Provider-announced retirement date, if any. */
  expirationDate?: string;
}

/**
 * One model's usage on one day, aggregated across request variants
 * (standard/free/batch/thinking all describe the same underlying model).
 */
export interface RankingRow {
  /** Matches CatalogModel.canonicalSlug. */
  permaslug: string;
  date: string;
  /** Requests that day — the adoption measure the ranking is ordered by. */
  count: number;
  completionTokens: number;
  promptTokens: number;
  /**
   * Completion tokens that were reasoning tokens. A high share is the tell for
   * a reasoning-first model, which is unusable here: lib/providers.ts
   * reasoningParams() force-disables reasoning on every call, so such a model
   * is either rejected outright or runs crippled.
   */
  reasoningTokens: number;
  toolCalls: number;
  mediaPrompts: number;
  /** Day-over-day change as a FRACTION (0.62 = +62%), or null on the first day. */
  change: number | null;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const GOOGLE_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/models";
/**
 * Undocumented — this is the endpoint behind openrouter.ai/rankings, found by
 * reading that page, and it is the only public source of real adoption data
 * (the documented catalog's `?order=` parameter is silently ignored; it always
 * returns newest-first). It has no stability guarantee, which is why every
 * caller must treat a failure here as "no candidate suggestions today" rather
 * than a failed run.
 */
const OPENROUTER_RANKINGS_URL =
  "https://openrouter.ai/api/frontend/v1/rankings/models";

const FETCH_TIMEOUT_MS = 20_000;

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GET ${url} → HTTP ${response.status}`);
  }
  return response.json();
}

/** Per-token USD string → $/M number. Missing/unparseable prices read as 0. */
function perMillion(raw: unknown): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value * 1_000_000 : 0;
}

/**
 * The full OpenRouter catalog. Pricing arrives as per-token USD *strings*
 * (`"0.00000028"`) — arbitrary precision, hence strings — and is converted to
 * the $/M figures the rest of the system speaks.
 *
 * Note the base tier only: some models carry a `pricing.overrides` array that
 * charges more past a prompt-length threshold. Pages here are short, so the
 * base tier is the one we actually pay, and folding in a long-context override
 * would over-report cost against the spend cap.
 */
export async function fetchOpenRouterCatalog(): Promise<CatalogModel[]> {
  const body = await fetchJson(OPENROUTER_MODELS_URL);
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map((row: Record<string, never>): CatalogModel => {
    const architecture = (row.architecture ?? {}) as Record<string, unknown>;
    const pricing = (row.pricing ?? {}) as Record<string, unknown>;
    return {
      slug: String(row.id),
      canonicalSlug: row.canonical_slug ? String(row.canonical_slug) : undefined,
      provider: "openrouter",
      name: String(row.name ?? row.id),
      description: String(row.description ?? ""),
      pricePerMillion: perMillion(pricing.completion),
      promptPricePerMillion: perMillion(pricing.prompt),
      contextLength: Number(row.context_length ?? 0),
      modality: String(architecture.modality ?? ""),
      outputModalities: Array.isArray(architecture.output_modalities)
        ? (architecture.output_modalities as string[]).map(String)
        : [],
      supportedParameters: Array.isArray(row.supported_parameters)
        ? (row.supported_parameters as string[]).map(String)
        : [],
      expirationDate: row.expiration_date ? String(row.expiration_date) : undefined,
    };
  });
}

/**
 * Google's models, via the same OpenAI-compatible surface lib/providers.ts
 * calls. It lists ids and context sizes but NO pricing, so every row comes back
 * priced 0 — which is the right answer for the free-tier rows we actually run,
 * and why a Google model must never be auto-disabled by the price-spike guard
 * (there is no price to compare). Its purpose here is slug-death detection:
 * this catalog is what proves `gemini-3-flash` does not exist.
 *
 * Ids come back namespaced (`models/gemini-3.1-flash-lite`); the prefix is
 * stripped so the slug matches what a model_registry row stores.
 */
export async function fetchGoogleCatalog(apiKey: string): Promise<CatalogModel[]> {
  if (!apiKey) return [];
  const body = await fetchJson(GOOGLE_MODELS_URL, {
    authorization: `Bearer ${apiKey}`,
  });
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.map((row: Record<string, never>): CatalogModel => {
    const id = String(row.id).replace(/^models\//, "");
    return {
      slug: id,
      provider: "google",
      name: id,
      description: "",
      pricePerMillion: 0,
      promptPricePerMillion: 0,
      contextLength: Number(row.context_length ?? 0),
      modality: "text->text",
      outputModalities: ["text"],
      supportedParameters: [],
    };
  });
}

/**
 * The most recent day of the rankings feed, one row per model.
 *
 * Two aggregations happen here, both load-bearing:
 *
 *  1. **Across variants.** The feed reports `standard`, `free`, `batch`, and
 *     `thinking` separately for the same model. Summing them is what makes
 *     `count` mean "how much is this model used"; taking only `standard` would
 *     undercount, and the reasoning-share signal would lose the very variant
 *     that reveals it.
 *  2. **Across duplicate permaslugs.** Only the latest date is kept, so a model
 *     appears once — but the feed can carry two *dated versions* of the same
 *     family (`deepseek-v4-flash-20260423` and `-20260731`) as genuinely
 *     distinct entries. Those are deliberately NOT merged: they are different
 *     model versions, and only the one whose permaslug equals a catalog
 *     `canonical_slug` is the one we could actually run.
 *
 * `change` is carried from the largest variant rather than summed — it is a
 * ratio, and adding ratios is meaningless.
 */
export function latestRankings(rows: readonly RankingRow[]): Map<string, RankingRow> {
  const latest = rows.reduce((max, row) => (row.date > max ? row.date : max), "");
  const merged = new Map<string, RankingRow>();
  for (const row of rows) {
    if (row.date !== latest) continue;
    const existing = merged.get(row.permaslug);
    if (!existing) {
      merged.set(row.permaslug, { ...row });
      continue;
    }
    const dominant = row.count > existing.count;
    merged.set(row.permaslug, {
      ...existing,
      count: existing.count + row.count,
      completionTokens: existing.completionTokens + row.completionTokens,
      promptTokens: existing.promptTokens + row.promptTokens,
      reasoningTokens: existing.reasoningTokens + row.reasoningTokens,
      toolCalls: existing.toolCalls + row.toolCalls,
      mediaPrompts: existing.mediaPrompts + row.mediaPrompts,
      change: dominant ? row.change : existing.change,
    });
  }
  return merged;
}

/**
 * Daily usage rankings, already reduced to the latest day and keyed by
 * permaslug (join to `CatalogModel.canonicalSlug`).
 *
 * Returns `null` — never throws — when the endpoint is unreachable or has
 * changed shape. It is undocumented and may vanish without notice; when it
 * does, the review still runs and still applies every price/health action, it
 * just has nothing to suggest. Losing the nice-to-have must not cost us the
 * safety rails.
 */
export async function fetchOpenRouterRankings(): Promise<Map<string, RankingRow> | null> {
  try {
    const body = await fetchJson(OPENROUTER_RANKINGS_URL);
    const rows = Array.isArray(body?.data) ? body.data : [];
    if (rows.length === 0) return null;
    const parsed: RankingRow[] = rows.map((row: Record<string, never>) => ({
      permaslug: String(row.model_permaslug),
      date: String(row.date),
      count: Number(row.count ?? 0),
      completionTokens: Number(row.total_completion_tokens ?? 0),
      promptTokens: Number(row.total_prompt_tokens ?? 0),
      reasoningTokens: Number(row.total_native_tokens_reasoning ?? 0),
      toolCalls: Number(row.total_tool_calls ?? 0),
      mediaPrompts: Number(row.num_media_prompt ?? 0),
      change: row.change === null || row.change === undefined ? null : Number(row.change),
    }));
    return latestRankings(parsed);
  } catch {
    return null;
  }
}
