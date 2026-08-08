/**
 * The daily model-pool review: given the pool as it stands, the providers'
 * live catalogs, OpenRouter's usage rankings, and our own reader signals,
 * decide what to change.
 *
 * Pure by construction — no fetch, no database, no clock of its own (`now` is
 * an argument). Every branch below is reachable from a unit test with a plain
 * object, which is the only reason a job that can disable production models
 * unattended is safe to ship. lib/modelCatalog.ts does the I/O;
 * scripts/review-models.ts does the writing.
 *
 * The split between what applies itself and what waits for a human is the
 * whole design:
 *
 *   - **Automatic** actions only ever make the pool *smaller* or correct a
 *     number: repricing, and disabling models that expired, died, or got
 *     suddenly expensive. Being wrong costs variety for a day.
 *   - **Proposals** are anything that would make the pool *bigger* or spend
 *     more. Being wrong there costs money and puts unvetted prose in front of
 *     readers, so a person decides.
 *
 * Type-only imports below are erased before Node's native type stripping
 * resolves anything, so this file stays runnable from scripts/ with no build
 * step. Do not add a value import.
 */

import type { CatalogModel, CatalogProvider, RankingRow } from "./modelCatalog";

export type ReviewTask = "generation" | "moderation";

/** A model_registry row, as the review needs to see it. */
export interface PoolRow {
  slug: string;
  provider: CatalogProvider;
  task: ReviewTask;
  enabled: boolean;
  weight: number;
  order: number;
  health: string;
  pricePerMillion: number | null;
  baselinePrice: number | null;
  expiresAt: Date | null;
  trial: boolean;
}

/** One row of the `model_signals` view (lib/schema.sql) — our own evidence. */
export interface ModelSignal {
  model: string;
  pages: number;
  likes: number;
  dislikes: number;
  visits: number;
  avgMedianDwellMs: number | null;
}

export type AutoActionKind = "reprice" | "disable_expired" | "disable_dead" | "disable_spike";

/** A change the job makes on its own authority. */
export interface AutoAction {
  kind: AutoActionKind;
  slug: string;
  task: ReviewTask;
  provider: CatalogProvider;
  /** Human-readable, printed verbatim into the digest. */
  reason: string;
  /** reprice only: the value to write. */
  price?: number;
}

export type ProposalAction =
  | "add_trial"
  | "promote_trial"
  | "drop_trial"
  | "extend_trial"
  | "swap"
  | "reprice_baseline"
  | "disable";

/** A change that waits for an operator to confirm it on /operator. */
export interface Proposal {
  action: ProposalAction;
  slug: string;
  provider: CatalogProvider;
  task: ReviewTask;
  reason: string;
  /** Arguments for the apply route; persisted to model_proposals.payload. */
  payload: Record<string, unknown>;
  /** Ordering hint — urgent proposals are escalations, and lead the digest. */
  urgent?: boolean;
}

export interface ReviewResult {
  autoActions: AutoAction[];
  proposals: Proposal[];
  /** Anything the reader of the digest should know about the run itself. */
  notes: string[];
}

export interface ReviewOptions {
  /** Disable a model priced above `baseline × (1 + this)`. */
  spikeThreshold: number;
  /** Never auto-disable below this many enabled generation models. */
  minGenerationModels: number;
  /** Never auto-disable below this many enabled moderation links. */
  minModerationModels: number;
  /** Candidates above this $/M are not worth the risk. */
  maxCandidatePrice: number;
  /** Candidates must offer at least this much context. */
  minCandidateContext: number;
  /** Candidates must place at least this high in the daily usage ranking. */
  maxCandidateRank: number;
  /** How long a proposed trial runs before it expires on its own. */
  trialDays: number;
  /** Raise a verdict once a trial is within this long of expiring. */
  trialVerdictWithinDays: number;
  /** At most this many new candidates per digest. */
  maxCandidates: number;
}

export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = {
  spikeThreshold: 0.5,
  // Three is the smallest pool that still reads as a library rather than one
  // model's voice — variety is the product here, not a nice-to-have.
  minGenerationModels: 3,
  minModerationModels: 1,
  maxCandidatePrice: 5,
  minCandidateContext: 32_000,
  maxCandidateRank: 100,
  trialDays: 14,
  trialVerdictWithinDays: 3,
  maxCandidates: 3,
};

/**
 * Share of completion tokens that may be reasoning tokens before a model is
 * treated as reasoning-first. Such a model is unusable here regardless of how
 * good it is: lib/providers.ts reasoningParams() disables reasoning on every
 * call, so we would either get a 400 (several Gemini slugs do exactly this) or
 * a model running with its main faculty switched off.
 */
const MAX_REASONING_SHARE = 0.3;
/** Media prompts per request above which a model is really a vision model. */
const MAX_MEDIA_SHARE = 0.05;
/** Tool calls per request above which a model is really an agent model. */
const MAX_TOOL_SHARE = 0.5;

/**
 * Slug/description patterns that disqualify a candidate outright. Prose for
 * human readers is a narrow job, and the catalog is mostly not that: embedding
 * and rerank models can't chat at all, and vision/coder/agent models write
 * flat, task-shaped text. This is the filter that keeps a price-led search from
 * proposing something like `qwen3.7-flash` — cheap, well-ranked, and a
 * "vision-language reasoning model for visual coding and computer interaction".
 */
const DISQUALIFYING = /\b(embed|embedding|rerank|vision|image|video|audio|speech|tts|stt|coder|coding|guard|moderation|ocr|vl)\b/i;

const DAY_MS = 86_400_000;

function median(values: readonly number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(fraction: number): string {
  return `${fraction >= 0 ? "+" : ""}${Math.round(fraction * 100)}%`;
}

function usd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  return `$${value.toFixed(2)}`;
}

/**
 * Index the catalogs by slug *per provider*. Slugs are only unique within a
 * provider — the same name can legitimately exist on both — so a flat map would
 * let a Google row be validated against an OpenRouter entry and vice versa.
 */
function catalogIndex(catalog: readonly CatalogModel[]): Map<string, CatalogModel> {
  const index = new Map<string, CatalogModel>();
  for (const model of catalog) {
    index.set(`${model.provider}:${model.slug}`, model);
  }
  return index;
}

/**
 * Rank position (1-based) for every model in the usage feed, by request count.
 * Computed once so candidate evaluation stays O(1) per model.
 */
function rankPositions(rankings: ReadonlyMap<string, RankingRow>): Map<string, number> {
  const ordered = [...rankings.values()].sort((a, b) => b.count - a.count);
  const positions = new Map<string, number>();
  ordered.forEach((row, index) => positions.set(row.permaslug, index + 1));
  return positions;
}

/**
 * Does this model's usage profile look like prose generation rather than
 * agentic, multimodal, or reasoning work? Uses the rankings feed's own token
 * and call mix, which is far harder to game than a marketing description — and
 * catches models whose description says nothing at all.
 */
function usageLooksLikeProse(row: RankingRow): boolean {
  const reasoningShare =
    row.completionTokens > 0 ? row.reasoningTokens / row.completionTokens : 0;
  const mediaShare = row.count > 0 ? row.mediaPrompts / row.count : 0;
  const toolShare = row.count > 0 ? row.toolCalls / row.count : 0;
  return (
    reasoningShare <= MAX_REASONING_SHARE &&
    mediaShare <= MAX_MEDIA_SHARE &&
    toolShare <= MAX_TOOL_SHARE
  );
}

/** The hard filters — applied before anything is ranked or scored. */
function passesHardFilters(model: CatalogModel, options: ReviewOptions): boolean {
  if (model.provider !== "openrouter") return false;
  // `:free` rows activate the free-tier cap branch in lib/generate.ts, which
  // has never run in production. Not something to switch on unattended.
  if (model.slug.endsWith(":free")) return false;
  if (model.modality !== "text->text") return false;
  if (model.outputModalities.length > 0 && !model.outputModalities.includes("text")) {
    return false;
  }
  // Without `temperature` the whole entropy design (per-page jitter, seeded
  // levers) silently stops applying to this model.
  if (!model.supportedParameters.includes("temperature")) return false;
  if (model.contextLength < options.minCandidateContext) return false;
  if (model.pricePerMillion <= 0) return false; // free/unpriced → see :free above
  if (model.pricePerMillion > options.maxCandidatePrice) return false;
  if (model.expirationDate) return false; // already scheduled for retirement
  if (DISQUALIFYING.test(model.slug) || DISQUALIFYING.test(model.name)) return false;
  if (DISQUALIFYING.test(model.description.slice(0, 400))) return false;
  return true;
}

export interface ReviewInput {
  pool: readonly PoolRow[];
  catalog: readonly CatalogModel[];
  /** Keyed by permaslug; `null` when the undocumented feed was unreachable. */
  rankings: ReadonlyMap<string, RankingRow> | null;
  signals: readonly ModelSignal[];
  now: Date;
  /** Providers whose catalog was fetched successfully this run. */
  cataloguedProviders: readonly CatalogProvider[];
  options?: Partial<ReviewOptions>;
}

/**
 * Run the review. Returns what to do; writes nothing.
 */
export function reviewPool(input: ReviewInput): ReviewResult {
  const options = { ...DEFAULT_REVIEW_OPTIONS, ...input.options };
  const { pool, now } = input;
  const catalog = catalogIndex(input.catalog);
  const autoActions: AutoAction[] = [];
  const proposals: Proposal[] = [];
  const notes: string[] = [];

  const catalogued = new Set(input.cataloguedProviders);
  for (const provider of ["openrouter", "google"] as const) {
    if (!catalogued.has(provider)) {
      notes.push(
        `${provider} catalog unavailable — its rows were left untouched this run`,
      );
    }
  }

  // ── Floor guard ────────────────────────────────────────────────────────────
  // Track how many rows would still be enabled per task as disables accumulate.
  // Every auto-disable consults this, so a bad catalog fetch that makes the
  // whole pool look dead can shrink it to the floor and no further. Without it
  // one bad response takes the library dark with nobody in the loop.
  const remaining: Record<ReviewTask, number> = {
    generation: pool.filter((r) => r.task === "generation" && r.enabled).length,
    moderation: pool.filter((r) => r.task === "moderation" && r.enabled).length,
  };
  const floor: Record<ReviewTask, number> = {
    generation: options.minGenerationModels,
    moderation: options.minModerationModels,
  };

  /**
   * Take one slot off the pool if the floor allows. Returns false when the
   * disable must be escalated to a human instead of applied.
   */
  function claimDisable(task: ReviewTask): boolean {
    if (remaining[task] - 1 < floor[task]) return false;
    remaining[task] -= 1;
    return true;
  }

  function escalate(row: PoolRow, reason: string): void {
    proposals.push({
      action: "disable",
      slug: row.slug,
      provider: row.provider,
      task: row.task,
      reason: `${reason} — NOT auto-applied: would leave fewer than ${floor[row.task]} enabled ${row.task} models`,
      payload: { task: row.task },
      urgent: true,
    });
  }

  // ── Per-row pass: price sync, expiry, slug death, price spikes ─────────────
  for (const row of pool) {
    const model = catalog.get(`${row.provider}:${row.slug}`);
    const providerCatalogued = catalogued.has(row.provider);

    // Expiry. Applied unconditionally, ahead of the floor guard, because
    // lib/registry.ts poolFor() already stops selecting an expired row at the
    // exact instant it lapses — the write here only records a fact that is
    // true either way. Blocking it would leave `enabled = true` on a row
    // nothing can select, which is the one state an operator must never be
    // shown. A resulting floor breach is reported below instead.
    if (row.enabled && row.expiresAt && row.expiresAt <= now) {
      autoActions.push({
        kind: "disable_expired",
        slug: row.slug,
        task: row.task,
        provider: row.provider,
        reason: row.trial
          ? `trial window ended ${row.expiresAt.toISOString().slice(0, 10)}`
          : `expired ${row.expiresAt.toISOString().slice(0, 10)}`,
      });
      remaining[row.task] -= 1;
      continue;
    }

    // Slug death. Only meaningful when we actually got that provider's catalog
    // — an unreachable provider must not read as "every one of its models
    // vanished".
    if (providerCatalogued && !model) {
      if (!row.enabled) continue; // already off; nothing to do
      const reason = `absent from the ${row.provider} catalog (slug is dead)`;
      if (claimDisable(row.task)) {
        autoActions.push({
          kind: "disable_dead",
          slug: row.slug,
          task: row.task,
          provider: row.provider,
          reason,
        });
      } else {
        escalate(row, reason);
      }
      continue;
    }

    if (!model) continue;

    // Price sync. Google's catalog reports no pricing at all, so its rows
    // would otherwise be repriced to 0 on every run; skip them and let the
    // free-tier convention (absent price → 0) stand on its own.
    const catalogPrice = model.pricePerMillion;
    if (row.provider !== "google" && catalogPrice !== row.pricePerMillion) {
      autoActions.push({
        kind: "reprice",
        slug: row.slug,
        task: row.task,
        provider: row.provider,
        price: catalogPrice,
        reason: `${usd(row.pricePerMillion)} → ${usd(catalogPrice)} /M`,
      });
    }

    // Price spike. Needs a baseline to compare against; a NULL baseline means
    // "never stamped", and treating that as 0 would make every priced model
    // look infinitely more expensive and disable the entire pool.
    if (
      row.enabled &&
      row.provider !== "google" &&
      row.baselinePrice !== null &&
      row.baselinePrice > 0 &&
      catalogPrice > row.baselinePrice * (1 + options.spikeThreshold)
    ) {
      const rise = catalogPrice / row.baselinePrice - 1;
      const reason =
        `${usd(row.baselinePrice)} → ${usd(catalogPrice)} /M (${pct(rise)}, ` +
        `barrier ${pct(options.spikeThreshold)})`;
      if (claimDisable(row.task)) {
        autoActions.push({
          kind: "disable_spike",
          slug: row.slug,
          task: row.task,
          provider: row.provider,
          reason,
        });
      } else {
        escalate(row, reason);
      }
      continue;
    }

    // A material price *drop* is the mirror image and worth a human's
    // attention: it may be a permanent reprice worth re-baselining, or a
    // promotion worth riding with an expires_at until it ends.
    if (
      row.enabled &&
      row.provider !== "google" &&
      row.baselinePrice !== null &&
      row.baselinePrice > 0 &&
      catalogPrice > 0 &&
      catalogPrice < row.baselinePrice * 0.75
    ) {
      const drop = catalogPrice / row.baselinePrice - 1;
      proposals.push({
        action: "reprice_baseline",
        slug: row.slug,
        provider: row.provider,
        task: row.task,
        reason: `${usd(row.baselinePrice)} → ${usd(catalogPrice)} /M (${pct(drop)}) — re-baseline, or set an expiry if it's a promotion`,
        payload: { baselinePrice: catalogPrice },
      });
    }
  }

  for (const task of ["generation", "moderation"] as const) {
    if (remaining[task] < floor[task]) {
      notes.push(
        `⚠ only ${remaining[task]} enabled ${task} model(s) left — below the floor of ${floor[task]}`,
      );
    }
  }

  // ── Provider-announced retirements ────────────────────────────────────────
  // A hard signal, unlike guessing at version numbers: the catalog itself says
  // this model is going away, so a replacement should be chosen deliberately
  // rather than discovered when it starts 404ing.
  for (const row of pool) {
    if (!row.enabled) continue;
    const model = catalog.get(`${row.provider}:${row.slug}`);
    if (!model?.expirationDate) continue;
    proposals.push({
      action: "swap",
      slug: row.slug,
      provider: row.provider,
      task: row.task,
      reason: `provider retires this model on ${model.expirationDate} — pick a replacement`,
      payload: { expirationDate: model.expirationDate },
      urgent: true,
    });
  }

  proposals.push(...trialVerdicts(pool, input.signals, now, options));
  proposals.push(...candidates(input, catalog, options, notes));

  // Urgent first, then by action, so the digest's shape is stable run to run
  // and a genuine escalation can't be pushed below routine noise.
  proposals.sort((a, b) => Number(b.urgent ?? false) - Number(a.urgent ?? false));

  return { autoActions, proposals, notes };
}

/**
 * Verdicts on trials nearing their expiry. This is the only place our own
 * reader evidence decides anything, and it is deliberately the *last* word:
 * the rankings feed can say the market likes a model, but only `model_signals`
 * can say whether it holds a reader on the page.
 *
 * Dwell is the primary measure — a page nobody finishes is a bad page whatever
 * its like count — with the like ratio as a tiebreak. Both are compared to the
 * pool's own median rather than an absolute threshold, so a general shift in
 * reading behaviour doesn't quietly condemn every trial.
 */
function trialVerdicts(
  pool: readonly PoolRow[],
  signals: readonly ModelSignal[],
  now: Date,
  options: ReviewOptions,
): Proposal[] {
  const bySlug = new Map(signals.map((s) => [s.model, s]));
  const established = pool.filter((r) => r.task === "generation" && r.enabled && !r.trial);
  const dwellMedian = median(
    established
      .map((r) => bySlug.get(r.slug)?.avgMedianDwellMs)
      .filter((v): v is number => typeof v === "number" && v > 0),
  );

  const out: Proposal[] = [];
  for (const row of pool) {
    if (!row.trial || !row.enabled || !row.expiresAt) continue;
    const daysLeft = (row.expiresAt.getTime() - now.getTime()) / DAY_MS;
    if (daysLeft > options.trialVerdictWithinDays || daysLeft < 0) continue;

    const signal = bySlug.get(row.slug);
    // A trial with nothing to judge is not evidence of failure — the weighted
    // lottery may simply never have drawn it. Say so rather than dropping it
    // on silence, and let the window extend.
    if (!signal || signal.pages === 0) {
      out.push({
        action: "extend_trial",
        slug: row.slug,
        provider: row.provider,
        task: row.task,
        reason: `trial ends in ${Math.max(0, Math.round(daysLeft))}d with no pages generated — extend by ${options.trialDays}d to get a verdict, or let it lapse`,
        payload: { extendDays: options.trialDays },
      });
      continue;
    }

    const dwell = signal.avgMedianDwellMs ?? 0;
    const votes = signal.likes + signal.dislikes;
    const likeRatio = votes > 0 ? signal.likes / votes : null;
    const dwellNote =
      dwellMedian === null
        ? `dwell ${Math.round(dwell / 1000)}s (no pool median yet)`
        : `dwell ${Math.round(dwell / 1000)}s vs pool median ${Math.round(dwellMedian / 1000)}s`;
    const likeNote = likeRatio === null ? "no votes" : `likes ${Math.round(likeRatio * 100)}%`;
    const beatsDwell = dwellMedian !== null && dwell >= dwellMedian * 0.9;
    const beatsLikes = likeRatio !== null && likeRatio >= 0.5;

    if (beatsDwell || (dwellMedian === null && beatsLikes)) {
      out.push({
        action: "promote_trial",
        slug: row.slug,
        provider: row.provider,
        task: row.task,
        reason: `${dwellNote}, ${likeNote} over ${signal.pages} pages → promote`,
        payload: { weight: 10 },
      });
    } else {
      out.push({
        action: "drop_trial",
        slug: row.slug,
        provider: row.provider,
        task: row.task,
        reason: `${dwellNote}, ${likeNote} over ${signal.pages} pages → drop`,
        payload: {},
      });
    }
  }
  return out;
}

/**
 * New models worth trying, via the four-stage gate. Each stage is a hard gate
 * rather than a weight, so a model cannot buy its way in on price alone — the
 * failure mode that price-led selection always produces.
 *
 *   1. Hard filters      — is this even a prose model we can drive?
 *   2. Adoption floor    — is anyone actually using it? (cheap and obscure is
 *                          how you ship slop)
 *   3. Momentum          — is it on the way up rather than out?
 *   4. Price advantage   — is it cheaper than what we already run?
 *
 * Survivors are proposed as trials, never as permanent members: the rankings
 * tell us what the market thinks, and only a trial can tell us what our readers
 * think.
 */
function candidates(
  input: ReviewInput,
  catalog: Map<string, CatalogModel>,
  options: ReviewOptions,
  notes: string[],
): Proposal[] {
  const { rankings, pool } = input;
  if (!rankings) {
    notes.push(
      "usage rankings unavailable — no new-model suggestions this run (safety actions unaffected)",
    );
    return [];
  }

  const positions = rankPositions(rankings);
  const inPool = new Set(pool.map((r) => `${r.provider}:${r.slug}`));

  // Join sanity. The feed keys on OpenRouter's dated permaslug
  // (`anthropic/claude-4.5-haiku-20251001`) while a registry row stores the
  // plain slug (`anthropic/claude-haiku-4.5`) — note those are NOT the same
  // string reordered, which is why the join goes through the catalog's
  // `canonical_slug` and never through string surgery on the slug itself. If
  // that link ever breaks, every model silently drops out of the ranking and
  // this function returns nothing while looking perfectly healthy. Say so.
  const enabledOpenRouter = pool.filter((r) => r.enabled && r.provider === "openrouter");
  const matched = enabledOpenRouter.filter((r) => {
    const model = catalog.get(`openrouter:${r.slug}`);
    return model?.canonicalSlug ? rankings.has(model.canonicalSlug) : false;
  }).length;
  if (enabledOpenRouter.length > 0 && matched / enabledOpenRouter.length < 0.5) {
    notes.push(
      `⚠ rankings join matched only ${matched}/${enabledOpenRouter.length} of our own models — the feed's shape may have changed; suggestions are unreliable`,
    );
  }

  // The bar to beat: what a generation slot costs us today.
  const poolMedianPrice =
    median(
      pool
        .filter((r) => r.task === "generation" && r.enabled)
        .map((r) => r.pricePerMillion)
        .filter((v): v is number => typeof v === "number" && v > 0),
    ) ?? options.maxCandidatePrice;

  const scored: { proposal: Proposal; score: number }[] = [];
  for (const model of catalog.values()) {
    if (inPool.has(`${model.provider}:${model.slug}`)) continue;
    if (!passesHardFilters(model, options)) continue; // stage 1

    const permaslug = model.canonicalSlug;
    if (!permaslug) continue;
    const usage = rankings.get(permaslug);
    if (!usage) continue;
    const rank = positions.get(permaslug) ?? Number.MAX_SAFE_INTEGER;
    if (rank > options.maxCandidateRank) continue; // stage 2
    if (!usageLooksLikeProse(usage)) continue; // stage 1, from usage rather than prose

    const change = usage.change;
    if (change === null || change <= 0) continue; // stage 3
    if (model.pricePerMillion >= poolMedianPrice) continue; // stage 4

    const saving = 1 - model.pricePerMillion / poolMedianPrice;
    // Rank is the dominant term (adoption is the strongest external evidence),
    // with growth and price advantage as modifiers.
    const score = (1 / rank) * 100 + Math.min(change, 5) + saving * 2;
    scored.push({
      score,
      proposal: {
        action: "add_trial",
        slug: model.slug,
        provider: model.provider,
        task: "generation",
        reason:
          `rank #${rank} by daily requests, ${pct(change)} d/d, ` +
          `${usd(model.pricePerMillion)}/M vs pool median ${usd(poolMedianPrice)} ` +
          `(${Math.round(saving * 100)}% cheaper)`,
        payload: {
          weight: 5,
          trial: true,
          trialDays: options.trialDays,
          pricePerMillion: model.pricePerMillion,
          promptPricePerMillion: model.promptPricePerMillion,
          contextLength: model.contextLength,
          rank,
        },
      },
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, options.maxCandidates)
    .map((entry) => entry.proposal);
}

/** Telegram's hard limit — sendMessage rejects a longer body outright. */
const TELEGRAM_MAX_CHARS = 4096;

/**
 * Render the digest. The message carries the full reasoning, not a teaser: the
 * point of the /operator link is to *apply* changes, not to go read what they
 * were. Kept pure and here (rather than in the script) so the exact text a
 * human will act on is unit-testable.
 */
export function formatDigest(
  result: ReviewResult,
  meta: { date: string; dashboardUrl?: string; dryRun?: boolean },
): string {
  const lines: string[] = [`Model pool — ${meta.date}${meta.dryRun ? " (dry run)" : ""}`];

  if (result.notes.length > 0) {
    lines.push("");
    for (const note of result.notes) lines.push(note);
  }

  if (result.autoActions.length > 0) {
    lines.push("", "APPLIED");
    for (const action of result.autoActions) {
      const verb =
        action.kind === "reprice"
          ? "reprice"
          : action.kind === "disable_expired"
            ? "expired"
            : action.kind === "disable_dead"
              ? "dead slug"
              : "price spike";
      lines.push(`  [${verb}] ${action.slug} (${action.task})`, `    ${action.reason}`);
    }
  }

  if (result.proposals.length > 0) {
    lines.push("", "PROPOSED");
    result.proposals.forEach((proposal, index) => {
      const mark = proposal.urgent ? " ⚠" : "";
      lines.push(
        `${String(index + 1).padStart(2)}.${mark} ${proposal.action} ${proposal.slug} (${proposal.task})`,
        `    ${proposal.reason}`,
      );
    });
  }

  if (result.autoActions.length === 0 && result.proposals.length === 0) {
    lines.push("", "No changes. Pool is current.");
  } else if (meta.dashboardUrl && result.proposals.length > 0) {
    lines.push("", `Review & apply → ${meta.dashboardUrl}`);
  }

  const text = lines.join("\n");
  if (text.length <= TELEGRAM_MAX_CHARS) return text;
  // Over the limit, the dashboard becomes the source of truth — but the tail
  // must still say so, so a truncated message is never mistaken for the whole
  // story.
  const tail = `\n… truncated — full list at ${meta.dashboardUrl ?? "/operator"}`;
  return text.slice(0, TELEGRAM_MAX_CHARS - tail.length) + tail;
}
