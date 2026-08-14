import { config } from "./config";
import { query } from "./db";

/**
 * Typed readers over the insight views (lib/schema.sql, docs/reference/architecture.md
 * §8 "Both": SQL views as source of truth). Rendered on /operator. Each
 * reader is a single query() against its view — the rollup logic lives in SQL,
 * not here.
 *
 * pg returns BIGINT/NUMERIC columns as strings (avoids silent precision loss
 * on values past 2^53); every reader converts them to `number` here since
 * these are display rollups, not money — the callers just want plain numbers.
 */

export interface PageSignal {
  address: string;
  model: string | null;
  promptVariant: string | null;
  temperature: number | null;
  createdAt: Date;
  likes: number;
  dislikes: number;
  openReports: number;
  visits: number;
  avgDwellMs: number | null;
  medianDwellMs: number | null;
}

interface PageSignalRow {
  address: string;
  model: string | null;
  prompt_variant: string | null;
  temperature: number | null;
  created_at: Date;
  likes: string;
  dislikes: string;
  open_reports: string;
  visits: string;
  avg_dwell_ms: string | null;
  median_dwell_ms: number | null;
}

function toPageSignal(row: PageSignalRow): PageSignal {
  return {
    address: row.address,
    model: row.model,
    promptVariant: row.prompt_variant,
    temperature: row.temperature,
    createdAt: row.created_at,
    likes: Number(row.likes),
    dislikes: Number(row.dislikes),
    openReports: Number(row.open_reports),
    visits: Number(row.visits),
    avgDwellMs: row.avg_dwell_ms === null ? null : Number(row.avg_dwell_ms),
    medianDwellMs: row.median_dwell_ms,
  };
}

/** Per-page rollup, busiest pages first (ties broken by address). */
export async function getPageSignals(limit = 100): Promise<PageSignal[]> {
  const rows = await query<PageSignalRow>(
    `SELECT address, model, prompt_variant, temperature, created_at,
            likes, dislikes, open_reports, visits, avg_dwell_ms, median_dwell_ms
     FROM page_signals
     ORDER BY visits DESC, address
     LIMIT $1`,
    [limit],
    "insights.getPageSignals",
  );
  return rows.map(toPageSignal);
}

export interface ModelSignal {
  model: string | null;
  pages: number;
  likes: number;
  dislikes: number;
  openReports: number;
  visits: number;
  avgMedianDwellMs: number | null;
}

interface ModelSignalRow {
  model: string | null;
  pages: string;
  likes: string;
  dislikes: string;
  open_reports: string;
  visits: string;
  avg_median_dwell_ms: string | null;
}

function toModelSignal(row: ModelSignalRow): ModelSignal {
  return {
    model: row.model,
    pages: Number(row.pages),
    likes: Number(row.likes),
    dislikes: Number(row.dislikes),
    openReports: Number(row.open_reports),
    visits: Number(row.visits),
    avgMedianDwellMs:
      row.avg_median_dwell_ms === null ? null : Number(row.avg_median_dwell_ms),
  };
}

/** Per-model rollup. */
export async function getModelSignals(): Promise<ModelSignal[]> {
  const rows = await query<ModelSignalRow>(
    `SELECT model, pages, likes, dislikes, open_reports, visits, avg_median_dwell_ms
     FROM model_signals
     ORDER BY visits DESC`,
    [],
    "insights.getModelSignals",
  );
  return rows.map(toModelSignal);
}

export interface VariantSignal {
  promptVariant: string | null;
  pages: number;
  likes: number;
  dislikes: number;
  openReports: number;
  visits: number;
  avgMedianDwellMs: number | null;
}

interface VariantSignalRow {
  prompt_variant: string | null;
  pages: string;
  likes: string;
  dislikes: string;
  open_reports: string;
  visits: string;
  avg_median_dwell_ms: string | null;
}

function toVariantSignal(row: VariantSignalRow): VariantSignal {
  return {
    promptVariant: row.prompt_variant,
    pages: Number(row.pages),
    likes: Number(row.likes),
    dislikes: Number(row.dislikes),
    openReports: Number(row.open_reports),
    visits: Number(row.visits),
    avgMedianDwellMs:
      row.avg_median_dwell_ms === null ? null : Number(row.avg_median_dwell_ms),
  };
}

/** Per-prompt-variant rollup. */
export async function getVariantSignals(): Promise<VariantSignal[]> {
  const rows = await query<VariantSignalRow>(
    `SELECT prompt_variant, pages, likes, dislikes, open_reports, visits, avg_median_dwell_ms
     FROM variant_signals
     ORDER BY visits DESC`,
    [],
    "insights.getVariantSignals",
  );
  return rows.map(toVariantSignal);
}

export interface ArrivalSignal {
  arrivedVia: string | null;
  visits: number;
  avgDwellMs: number | null;
  medianDwellMs: number | null;
}

interface ArrivalSignalRow {
  arrived_via: string | null;
  visits: string;
  avg_dwell_ms: string | null;
  median_dwell_ms: number | null;
}

function toArrivalSignal(row: ArrivalSignalRow): ArrivalSignal {
  return {
    arrivedVia: row.arrived_via,
    visits: Number(row.visits),
    avgDwellMs: row.avg_dwell_ms === null ? null : Number(row.avg_dwell_ms),
    medianDwellMs: row.median_dwell_ms,
  };
}

/** Per-arrival-route rollup (NULL group = unknown/direct entry). */
export async function getArrivalSignals(): Promise<ArrivalSignal[]> {
  const rows = await query<ArrivalSignalRow>(
    `SELECT arrived_via, visits, avg_dwell_ms, median_dwell_ms
     FROM arrival_signals
     ORDER BY visits DESC`,
    [],
    "insights.getArrivalSignals",
  );
  return rows.map(toArrivalSignal);
}

// --- System health (§2.5: "one page you refresh when someone says it's
// broken"), as opposed to the content/research rollups above. Plain queries
// against the raw tables rather than SQL views — unlike the per-page/model/
// variant/arrival rollups, nothing else in the app needs these joins, so a
// view would just be indirection.

export interface MonitorEventRow {
  id: number;
  event: string;
  fields: Record<string, unknown>;
  deployment: string | null;
  createdAt: Date;
}

/** The most recent monitor() events (lib/monitor.ts), newest first. */
export async function getRecentMonitorEvents(
  limit = 50,
): Promise<MonitorEventRow[]> {
  const rows = await query<{
    id: string;
    event: string;
    fields: Record<string, unknown>;
    deployment: string | null;
    created_at: Date;
  }>(
    `SELECT id, event, fields, deployment, created_at
     FROM monitor_events
     ORDER BY id DESC
     LIMIT $1`,
    [limit],
    "insights.getRecentMonitorEvents",
  );
  return rows.map((r) => ({
    id: Number(r.id),
    event: r.event,
    fields: r.fields,
    deployment: r.deployment,
    createdAt: r.created_at,
  }));
}

export interface SpendStatus {
  month: string;
  spendUsd: number;
  capUsd: number;
  pct: number;
}

/** This month's spend against the cap (lib/economics.ts), as a percentage. */
export async function getSpendStatus(): Promise<SpendStatus> {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM, UTC — matches economics.ts currentMonth()
  const rows = await query<{ cost_usd: string }>(
    "SELECT cost_usd FROM monthly_spend WHERE month = $1",
    [month],
    "insights.getSpendStatus",
  );
  const spendUsd = Number(rows[0]?.cost_usd ?? 0);
  const capUsd = config.monthlySpendCapUsd;
  return { month, spendUsd, capUsd, pct: capUsd > 0 ? (spendUsd / capUsd) * 100 : 0 };
}

export interface ModelHealth {
  slug: string;
  task: string;
  provider: string;
  enabled: boolean;
  health: string;
  calls: number;
  errors: number;
  avgMs: number | null;
  lastUsedAt: Date | null;
}

/**
 * Registered model config (model_registry) joined to its call stats
 * (model_stats). model_stats is keyed by slug alone, not (slug, task) — a
 * model used for both generation and moderation shows the same combined
 * calls/errors on both rows, since the counters don't split by task.
 */
export async function getModelHealth(): Promise<ModelHealth[]> {
  const rows = await query<{
    slug: string;
    task: string;
    provider: string;
    enabled: boolean;
    health: string;
    calls: string | null;
    errors: string | null;
    total_ms: string | null;
    last_used_at: Date | null;
  }>(
    `SELECT r.slug, r.task, r.provider, r.enabled, r.health,
            s.calls, s.errors, s.total_ms, s.last_used_at
     FROM model_registry r
     LEFT JOIN model_stats s ON s.model = r.slug
     ORDER BY r.task, r.slug`,
    [],
    "insights.getModelHealth",
  );
  return rows.map((r) => {
    const calls = Number(r.calls ?? 0);
    return {
      slug: r.slug,
      task: r.task,
      provider: r.provider,
      enabled: r.enabled,
      health: r.health,
      calls,
      errors: Number(r.errors ?? 0),
      avgMs: calls > 0 ? Number(r.total_ms ?? 0) / calls : null,
      lastUsedAt: r.last_used_at,
    };
  });
}

export interface TrafficSummary {
  pagesCreated24h: number;
  pageEvents24h: number;
}

/** Raw traffic volume over the last 24h — pages minted and reader beacons. */
export async function getTrafficSummary(): Promise<TrafficSummary> {
  const [pagesRows, eventsRows] = await Promise.all([
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pages
       WHERE created_at > now() - interval '24 hours'`,
      [],
      "insights.getTrafficSummary.pages",
    ),
    query<{ count: string }>(
      `SELECT count(*)::text AS count FROM page_events
       WHERE created_at > now() - interval '24 hours'`,
      [],
      "insights.getTrafficSummary.events",
    ),
  ]);
  return {
    pagesCreated24h: Number(pagesRows[0]?.count ?? 0),
    pageEvents24h: Number(eventsRows[0]?.count ?? 0),
  };
}
