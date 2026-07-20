/**
 * A deterministic PRNG seeded from a string — the mechanism that makes a page
 * a function of its address (docs/reference/generation.md). Generation levers
 * (model, temperature jitter, constraint sampling) are drawn from this stream
 * instead of Math.random(), so the same address always crystallizes the same
 * page: the coordinate *is* the seed, in the Borges sense that position
 * determines the book.
 *
 * xmur3 hashes the seed string to a 32-bit state; mulberry32 turns that state
 * into a uniform [0, 1) stream. Both are small, well-known, dependency-free,
 * and stable across platforms — the same seed yields the same sequence
 * everywhere, which is the whole point. Not cryptographic; it never needs to
 * be.
 */
export function makeSeededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h ^= h >>> 16) >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seed for one generation attempt at an address. The first attempt seeds
 * on the bare address (the page *is* its coordinate); a moderation- or dedup-
 * regeneration folds in the attempt index so the retry deterministically draws
 * a different sample instead of repeating the rejected/colliding one.
 */
export function attemptSeed(address: string, attempt: number): string {
  return attempt === 0 ? address : `${address}#${attempt}`;
}
