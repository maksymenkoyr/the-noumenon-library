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
  );
  return rows.map(toArrivalSignal);
}
