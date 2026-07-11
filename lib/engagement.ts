import { formatAddress, normalizeAddress } from "./address";
import { config } from "./config";
import { query } from "./db";
import { ipHash } from "./ipHash";

/**
 * Reader signals — the "like"/press count and dwell-time research signal
 * (docs/architecture.md §8, Phase 10). Two storage idioms, both mirroring the
 * economics counter tables: an aggregate per-page counter (page_likes, like
 * monthly_spend) and an append-only event log (engagement, like rate_limit_hits).
 *
 * This module owns page_likes, engagement, and engagement_rate_limit_hits and
 * nothing page-content-related. Every address is validated here before it keys a
 * row — the client string is never trusted (lib/address.ts).
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

/**
 * Record one dwell-time event. `dwellMs` is bounded to a sane range (sub-zero or
 * absurd values are dropped, not stored); `arrivedVia` is best-effort and stored
 * only when it's one of the known values, else NULL. No identifiers — this is
 * aggregate behavioral signal (docs/legal.md).
 */
export async function recordDwell(
  address: string,
  dwellMs: number,
  arrivedVia?: string,
): Promise<void> {
  if (!Number.isFinite(dwellMs) || dwellMs < 0 || dwellMs > MAX_DWELL_MS) return;
  const via = arrivedVia && ARRIVED_VIA.includes(arrivedVia) ? arrivedVia : null;
  await query(
    "INSERT INTO engagement (address, dwell_ms, arrived_via) VALUES ($1, $2, $3)",
    [address, Math.round(dwellMs), via],
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
