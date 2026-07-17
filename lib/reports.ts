import { query } from "./db";

/**
 * Reader content reports — the operator's review queue (docs/reference/architecture.md
 * §8). Distinct from the dislike taste signal: a report says "someone should
 * look at this", so it is an append-only row that stays open until the
 * operator resolves it (/operator). Resolving is only an acknowledgement —
 * removal stays with scripts/takedown.mjs.
 *
 * No user identifiers are stored (docs/reference/legal.md); the write endpoint throttles
 * by hashed IP upstream and that table never joins to this one.
 */

// Enough for "this page defames X" / a copyright pointer; anything longer is
// pasted content we don't want to store, so it's cut, not rejected.
const MAX_REASON_CHARS = 500;

export interface PageReport {
  id: number;
  address: string;
  reason: string | null;
  status: "open" | "resolved";
  createdAt: Date;
  resolvedAt: Date | null;
}

interface ReportRow {
  id: string;
  address: string;
  reason: string | null;
  status: "open" | "resolved";
  created_at: Date;
  resolved_at: Date | null;
}

function toReport(row: ReportRow): PageReport {
  return {
    id: Number(row.id),
    address: row.address,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Store one report. `firstOpenForAddress` is true when the address had no
 * other open report at insert time — the caller uses it to send at most one
 * operator email per page until that page is next reviewed, so a hot page
 * can't flood the inbox.
 */
export async function recordReport(
  address: string,
  reason?: string,
): Promise<{ id: number; firstOpenForAddress: boolean }> {
  const trimmed = reason?.trim().slice(0, MAX_REASON_CHARS);
  const prior = await query<{ count: string }>(
    "SELECT count(*) AS count FROM page_reports WHERE address = $1 AND status = 'open'",
    [address],
  );
  const rows = await query<{ id: string }>(
    "INSERT INTO page_reports (address, reason) VALUES ($1, $2) RETURNING id",
    [address, trimmed || null],
  );
  // Two statements, not one atomic check: a same-instant duplicate report can
  // at worst cost one extra email, which the fail-open channel tolerates.
  return {
    id: Number(rows[0].id),
    firstOpenForAddress: Number(prior[0].count) === 0,
  };
}

/** The open queue, oldest first — review order. */
export async function listOpenReports(): Promise<PageReport[]> {
  const rows = await query<ReportRow>(
    `SELECT id, address, reason, status, created_at, resolved_at
     FROM page_reports WHERE status = 'open' ORDER BY created_at, id`,
  );
  return rows.map(toReport);
}

/**
 * Mark one report resolved. Returns false when the id is unknown or already
 * resolved, so a stale/duplicate click is a no-op rather than an error.
 */
export async function resolveReport(id: number): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE page_reports SET status = 'resolved', resolved_at = now()
     WHERE id = $1 AND status = 'open' RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
