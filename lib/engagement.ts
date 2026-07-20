import { formatAddress, normalizeAddress } from "./address";
import { config } from "./config";
import { query } from "./db";
import { ipHash } from "./ipHash";

/**
 * Reader signals — the "like"/press count and dwell-time research signal
 * (docs/reference/architecture.md §8, Phase 10). Two storage idioms, both mirroring the
 * economics counter tables: an aggregate per-page counter (page_likes, like
 * monthly_spend) and an append-only event log (page_events, like rate_limit_hits).
 * `engagement` sits between the two — one upserted summary row per page-load
 * (idle-corrected dwell_ms), recomputed from that load's page_events rows.
 *
 * This module owns page_likes, page_events, engagement, and
 * engagement_rate_limit_hits, and nothing page-content-related. Every address
 * is validated here before it keys a row — the client string is never trusted
 * (lib/address.ts).
 */

export type ArrivedVia = "random" | "next" | "typed";
const ARRIVED_VIA: readonly string[] = ["random", "next", "typed"];

// A single reading session can't plausibly exceed this; anything larger is a
// runaway timer / stale tab / hostile client and is dropped rather than stored.
const MAX_DWELL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Canonicalize an untrusted address string to the store's primary-key form, or
 * null if it isn't a valid address. Accepts the `gallery/wall/shelf/volume/page`
 * string the client renders in the header; splits and runs it through the frozen
 * normalizer so a non-canonical form can never mint a stray row.
 */
export function canonicalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const addr = normalizeAddress(raw.split("/"));
  return addr ? formatAddress(addr) : null;
}

/**
 * Apply a press (+1) or un-press (-1) to a page's aggregate like count and
 * return the new total. Atomic upsert so concurrent presses accumulate; the
 * count is clamped at 0 so a stray un-press can't drive it negative. The FK to
 * pages(address) holds because marks only render on committed (`ok`) leaves.
 */
export async function pressLeaf(
  address: string,
  pressed: boolean,
): Promise<number> {
  const delta = pressed ? 1 : -1;
  const rows = await query<{ count: string }>(
    `INSERT INTO page_likes (address, count)
     VALUES ($1, GREATEST($2, 0))
     ON CONFLICT (address) DO UPDATE SET
       count = GREATEST(page_likes.count + $2, 0)
     RETURNING count`,
    [address, delta],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Current aggregate like count for a page (0 if none). */
export async function getLikeCount(address: string): Promise<number> {
  const rows = await query<{ count: string }>(
    "SELECT count FROM page_likes WHERE address = $1",
    [address],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Apply a "not for me" mark (+1) or unmark (-1) — the silent counterpart of
 * pressLeaf, against page_dislikes. The returned count is for tests and the
 * operator's insight views only; it is never sent to readers (the dislike is a
 * research signal, not a public score).
 */
export async function dislikeLeaf(
  address: string,
  disliked: boolean,
): Promise<number> {
  const delta = disliked ? 1 : -1;
  const rows = await query<{ count: string }>(
    `INSERT INTO page_dislikes (address, count)
     VALUES ($1, GREATEST($2, 0))
     ON CONFLICT (address) DO UPDATE SET
       count = GREATEST(page_dislikes.count + $2, 0)
     RETURNING count`,
    [address, delta],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Current aggregate dislike count for a page (0 if none). Operator-only. */
export async function getDislikeCount(address: string): Promise<number> {
  const rows = await query<{ count: string }>(
    "SELECT count FROM page_dislikes WHERE address = $1",
    [address],
  );
  return Number(rows[0]?.count ?? 0);
}

/** One raw client-emitted timeline event, as beaconed by marks.tsx. */
export interface RawEvent {
  e: string;
  t: number;
  seq: number;
  via?: string;
}

const ALLOWED_EVENTS: readonly string[] = [
  "arrive",
  "visible",
  "hidden",
  "idle",
  "active",
  "leave",
];

/**
 * Record one beacon's worth of raw timeline events for a page-load, then
 * recompute and upsert that load's `engagement` summary row (idle-corrected
 * dwell_ms) from the full event history in `page_events`. Multiple beacons for
 * the same loadId (e.g. one per tab-hide, plus a final one on page-hide) are
 * safe: page_events dedupes on (load_id, seq) and engagement upserts on
 * load_id, so a re-sent or overlapping tail is a no-op / recompute, never a
 * duplicate. No identifiers beyond the ephemeral, in-memory loadId — this is
 * aggregate behavioral signal (docs/reference/legal.md).
 */
export async function recordEvents(
  address: string,
  loadId: string,
  events: RawEvent[],
  device: string | null,
): Promise<void> {
  const valid = events.filter(
    (ev) =>
      ALLOWED_EVENTS.includes(ev.e) &&
      Number.isFinite(ev.t) &&
      ev.t >= 0 &&
      Number.isInteger(ev.seq),
  );
  if (valid.length === 0) return;

  // Single bulk insert (event batches are small — single digits per beacon —
  // but there's no reason to round-trip once per event). ON CONFLICT DO
  // NOTHING makes a re-sent/overlapping tail beacon idempotent.
  const values: string[] = [];
  const params: unknown[] = [];
  for (const ev of valid) {
    const via =
      ev.e === "arrive" && ev.via && ARRIVED_VIA.includes(ev.via) ? ev.via : null;
    const base = params.length;
    values.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`,
    );
    params.push(loadId, ev.seq, address, ev.e, Math.round(ev.t), device, via);
  }
  await query(
    `INSERT INTO page_events (load_id, seq, address, event, t_ms, device, arrived_via)
     VALUES ${values.join(", ")}
     ON CONFLICT (load_id, seq) DO NOTHING`,
    params,
  );

  const rows = await query<{
    event: string;
    t_ms: number;
    arrived_via: string | null;
  }>(
    `SELECT event, t_ms, arrived_via FROM page_events
     WHERE load_id = $1 ORDER BY seq ASC`,
    [loadId],
  );
  if (rows.length === 0) return;

  // Idle-corrected active time: a clock only runs between a "start" signal
  // (visible/active) and the next "stop" signal (idle/hidden/leave). "arrive"
  // itself never starts the clock — the client always emits "visible"
  // immediately after "arrive" when the page starts foregrounded, so a load
  // that starts visible is still counted from that first "visible" event.
  let activeMs = 0;
  let visibleSince: number | null = null;
  let arrivedVia: string | null = null;
  for (const row of rows) {
    if (row.arrived_via) arrivedVia = row.arrived_via;
    switch (row.event) {
      case "visible":
      case "active":
        // Unconditional: a "visible" event always follows a "hidden" (or the
        // initial "arrive"), never another "visible", so it always starts a
        // fresh clock — including when the reader had gone idle before
        // switching away, which "hidden" doesn't clear server-side.
        visibleSince = row.t_ms;
        break;
      case "idle":
      case "hidden":
      case "leave":
        if (visibleSince !== null) activeMs += row.t_ms - visibleSince;
        visibleSince = null;
        break;
    }
  }

  if (!Number.isFinite(activeMs) || activeMs < 0 || activeMs > MAX_DWELL_MS) return;

  await query(
    `INSERT INTO engagement (address, dwell_ms, arrived_via, load_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (load_id) WHERE load_id IS NOT NULL DO UPDATE SET
       dwell_ms = EXCLUDED.dwell_ms,
       arrived_via = EXCLUDED.arrived_via`,
    [address, Math.round(activeMs), arrivedVia, loadId],
  );
}

/**
 * Sliding-window throttle for the reader-signal write endpoints, keyed by hashed
 * IP. Returns true if this write is admitted. Records the hit and prunes rows
 * outside the window opportunistically, so nothing is retained long-term (§12).
 * No IP (local direct hit) → not throttled, rather than keying all anonymous
 * writes together — same convention as generation admission.
 */
export async function admitEngagementWrite(clientIp?: string): Promise<boolean> {
  if (!clientIp) return true;
  const hash = ipHash(clientIp);
  const window = config.engagementRateLimitWindowSeconds;

  const rows = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM engagement_rate_limit_hits
     WHERE ip_hash = $1 AND created_at > now() - make_interval(secs => $2)`,
    [hash, window],
  );
  if (Number(rows[0]?.count ?? 0) >= config.engagementRateLimitPerMinute) {
    return false;
  }

  await query(
    "INSERT INTO engagement_rate_limit_hits (ip_hash) VALUES ($1)",
    [hash],
  );
  await query(
    `DELETE FROM engagement_rate_limit_hits
     WHERE ip_hash = $1 AND created_at < now() - make_interval(secs => $2)`,
    [hash, window],
  );
  return true;
}
