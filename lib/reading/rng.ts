/**
 * A small deterministic PRNG local to lib/reading. The codebase already has
 * `lib/seededRandom.ts`, but that lives outside lib/reading and importing it
 * would break the "siblings only" purity rule this directory holds itself to
 * (no lib/config, lib/db, lib/providers, or any non-sibling import) — so this
 * is a minimal, self-contained equivalent, used for the recognition probe's
 * decoy selection (./probe.ts) and the sentence-shuffle negative control
 * (./controls.ts). Determinism matters here for the same reason it matters
 * in lib/seededRandom.ts: reproducible runs.
 */

/** Returns a float in [0, 1), like Math.random but seeded and repeatable. */
export type Rng = () => number;

/** mulberry32 — small, fast, good-enough distribution for shuffling/sampling
 * a few dozen items; not cryptographic. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** djb2 string hash, folded to an unsigned 32-bit seed — turns e.g. a page
 * address into a reproducible per-page seed. */
export function seedFromString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i);
  }
  return h >>> 0;
}

export function pickOne<T>(items: readonly T[], rng: Rng): T {
  return items[Math.floor(rng() * items.length)];
}

/** Fisher–Yates, seeded — never mutates `items`. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
