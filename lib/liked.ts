import { formatAddress, normalizeAddress } from "./address";

/**
 * The liked-page localStorage convention, shared by the like toggle
 * (app/[[...address]]/marks.tsx) and the /liked listing. Pure module (no node
 * imports), like lib/address.ts, so client components can import it.
 *
 * One key per liked page: `noumenon:liked:<address>`. The value is the like
 * time (`Date.now()` as a string) for recency ordering on /liked; marks
 * written before that convention stored `"1"`, so ANY non-null value means
 * liked and non-numeric values sort as oldest.
 */

export const LIKED_PREFIX = "noumenon:liked:";

// Fired on same-tab mark writes (cross-tab changes arrive as `storage`).
export const LIKE_EVENT = "noumenon:liked-change";

export const likedKey = (address: string) => LIKED_PREFIX + address;

export interface LikedEntry {
  address: string;
  likedAt: number; // ms epoch; 0 for legacy "1" marks
}

/**
 * Interpret one localStorage entry as a liked page, or null if it isn't one:
 * wrong prefix, a suffix that doesn't normalize to a canonical address (the
 * value of `likedKey` is client-written and not trusted), or a null value.
 */
export function parseLikedEntry(
  key: string,
  value: string | null,
): LikedEntry | null {
  if (value === null || !key.startsWith(LIKED_PREFIX)) return null;
  const addr = normalizeAddress(key.slice(LIKED_PREFIX.length).split("/"));
  if (!addr) return null;
  const likedAt = Number(value);
  return {
    address: formatAddress(addr),
    likedAt: Number.isFinite(likedAt) ? likedAt : 0,
  };
}

// Pre-rename key prefix (back when liking a page was called "pressing a
// leaf"), kept only to migrate existing readers' saved marks onto the
// noumenon:liked: convention above.
const LEGACY_PRESSED_PREFIX = "noumenon:pressed:";

let migrated = false;

/**
 * One-time, idempotent migration of legacy `noumenon:pressed:<address>` keys
 * to the current `noumenon:liked:<address>` convention, so readers who liked
 * pages before the rename don't lose their /liked list. Safe to call from
 * multiple client entry points (marks.tsx, liked-list.tsx); runs at most once
 * per page load. No-ops if localStorage is unavailable (private mode).
 */
export function migrateLegacyLikes(): void {
  if (migrated) return;
  migrated = true;
  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_PRESSED_PREFIX)) legacyKeys.push(key);
    }
    for (const key of legacyKeys) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        const newKey = LIKED_PREFIX + key.slice(LEGACY_PRESSED_PREFIX.length);
        if (localStorage.getItem(newKey) === null) {
          localStorage.setItem(newKey, value);
        }
      }
      localStorage.removeItem(key);
    }
  } catch {
    /* localStorage disabled (private mode) — nothing to migrate */
  }
}
