import { formatAddress, normalizeAddress } from "./address";

/**
 * The pressed-leaf localStorage convention, shared by the leaf toggle
 * (app/[[...address]]/marks.tsx) and the /liked listing. Pure module (no node
 * imports), like lib/address.ts, so client components can import it.
 *
 * One key per pressed leaf: `noumenon:pressed:<address>`. The value is the
 * press time (`Date.now()` as a string) for recency ordering on /liked; marks
 * written before that convention stored `"1"`, so ANY non-null value means
 * pressed and non-numeric values sort as oldest.
 */

export const PRESSED_PREFIX = "noumenon:pressed:";

// Fired on same-tab mark writes (cross-tab changes arrive as `storage`).
export const PRESS_EVENT = "noumenon:pressed-change";

export const pressedKey = (address: string) => PRESSED_PREFIX + address;

export interface PressedEntry {
  address: string;
  pressedAt: number; // ms epoch; 0 for legacy "1" marks
}

/**
 * Interpret one localStorage entry as a pressed leaf, or null if it isn't one:
 * wrong prefix, a suffix that doesn't normalize to a canonical address (the
 * value of `pressedKey` is client-written and not trusted), or a null value.
 */
export function parsePressedEntry(
  key: string,
  value: string | null,
): PressedEntry | null {
  if (value === null || !key.startsWith(PRESSED_PREFIX)) return null;
  const addr = normalizeAddress(key.slice(PRESSED_PREFIX.length).split("/"));
  if (!addr) return null;
  const pressedAt = Number(value);
  return {
    address: formatAddress(addr),
    pressedAt: Number.isFinite(pressedAt) ? pressedAt : 0,
  };
}
