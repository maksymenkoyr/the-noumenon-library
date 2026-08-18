/**
 * Damage applied to a page after it is cut — computed, not asked for.
 *
 * Same split as lib/pageCut.ts: **prompt what the model can do, compute what
 * it can't.** A model asked to "write a damaged page" performs damage — a
 * tidy `[illegible]` dropped into otherwise-normal prose, the anti-pattern
 * docs/reference/generation.md already warns about ("asking for 'a strange
 * page' — model performs strangeness; hollow"). So damage is never in the
 * prompt. It is applied here, to text that already passed generation, cutting,
 * and (next) moderation, exactly the way lib/pageCut.ts computes an ending
 * instead of requesting one.
 *
 * The fiction stays: a page is a found object, never a transcription of one.
 * `[illegible]` or any other editorial bracket implies a transcriber reading
 * the page and noting what they couldn't make out — a narrator this library
 * does not have. So the mark standing in for lost text is a typographic gap
 * (a run of a texture character), not an editor's annotation: it says the ink
 * is gone, not that someone looked and gave up.
 *
 * `none` is overwhelmingly the common case (see DAMAGES) — this module exists
 * to be a rare texture, not a default.
 *
 * Pure and synchronous: no config, no network, no clock. `pickDamage` draws
 * off the caller's seeded stream (lib/generate.ts chooseLevers, appended last
 * per its draw-order rule); `applyDamage` then derives *where* the damage
 * lands from the text itself — like lib/pageCut.ts's mid-word decision — so
 * the same stored text always damages the same way without a second lever.
 * `applyDamage`'s internal randomness (lib/seededRandom's xmur3 → mulberry32)
 * is seeded from the text itself, not from an address or attempt counter —
 * this module gets no seed of its own, and only ever sees text after the
 * model has already answered, so keying off the text is the only way to stay
 * reproducible without plumbing a second seeded stream down through the
 * pipeline.
 */

import { makeSeededRandom } from "./seededRandom";

/** How the page is damaged. Drawn per page and persisted as provenance. */
export type Damage = "none" | "lacuna" | "effaced" | "stutter";

export interface DamageOption {
  id: Damage;
  weight: number;
}

/**
 * `none` dominates: damage is a rare texture, not the library's default
 * condition — the concept doc's "every page is coherent-but-strange,
 * dreamlike, meant" holds for the overwhelming majority of pages, and this
 * pool must not erode that.
 *
 * `lacuna` (a contiguous phrase torn out) and `effaced` (scattered single
 * words worn away) both read as a **found object with a history** — real
 * archives hold plenty of water-damaged and rubbed-away paper, and a page
 * like that landing between two intact ones makes the intact ones more
 * credible, not less.
 *
 * `stutter` is a different kind of thing: a repeating, decaying phrase that
 * recovers — a genuine machine-glitch texture rather than physical damage.
 * Held far lower than the others on purpose. It is the one entry in this pool
 * that can read as *the site is broken* rather than *the page is wrong*,
 * which punctures the found-object fiction if it lands too often. Kept at all
 * because, rarely, it reads as the opposite — a page that has glitched rather
 * than aged, still recognizably an artifact, just a stranger kind.
 */
export const DAMAGES: readonly DamageOption[] = [
  { id: "none", weight: 85 },
  { id: "lacuna", weight: 10 },
  { id: "effaced", weight: 4 },
  { id: "stutter", weight: 1 },
];

/** Weighted draw from the damage pool, off the caller's seeded stream. */
export function pickDamage(rng: () => number): DamageOption {
  const total = DAMAGES.reduce((sum, o) => sum + o.weight, 0);
  let r = rng() * total;
  for (const option of DAMAGES) {
    r -= option.weight;
    if (r <= 0) return option;
  }
  return DAMAGES[DAMAGES.length - 1]; // floating-point rounding fallback
}

/** A word and where it sits in the source text. */
interface Word {
  text: string;
  start: number;
  end: number;
}

/**
 * Whitespace-delimited runs, matching lib/pageCut.ts's convention so a word
 * count taken here agrees with a word count taken anywhere else in the
 * codebase.
 */
function words(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Words this close to either edge are never damaged. The start seam
 * (lib/prompts.ts) and the cut edge (lib/pageCut.ts) are both deliberate —
 * damage landing on either would smudge a signal the pipeline already
 * computed on purpose, not add a second one.
 */
const EDGE_GUARD_WORDS = 3;

/** A page must hold this many words for damage to have anywhere safe to land. */
const MIN_WORDS_FOR_DAMAGE = 2 * EDGE_GUARD_WORDS + 4;

/**
 * The mark standing in for lost text: a run of a texture character, roughly
 * as wide as what it replaces. Not an editorial bracket (see header) and not
 * an ellipsis — an ellipsis at a cut edge already means "excerpt"
 * (lib/pageCut.ts strips it for exactly that reason), and reusing it mid-page
 * would say the same wrong thing here. Clamped so a long word doesn't produce
 * a implausibly wide gap and a short one doesn't produce an invisible one.
 */
function damageMark(charWidth: number): string {
  return "·".repeat(Math.max(3, Math.min(charWidth, 8)));
}

/**
 * Excise one contiguous run of 1–3 words and replace it with a single mark —
 * a phrase torn out, one hole in the page rather than several.
 */
function applyLacuna(text: string, all: Word[], rng: () => number): string {
  const span = 1 + Math.floor(rng() * 3); // 1..3
  const lo = EDGE_GUARD_WORDS;
  const hi = all.length - EDGE_GUARD_WORDS - span;
  if (hi < lo) return text; // page too short for a span this wide, safely
  const start = lo + Math.floor(rng() * (hi - lo + 1));
  const first = all[start];
  const last = all[start + span - 1];
  const mark = damageMark(last.end - first.start);
  return text.slice(0, first.start) + mark + text.slice(last.end);
}

/**
 * Wear away several scattered single words. Count scales lightly with page
 * length so a longer page doesn't read as proportionally cleaner.
 */
function applyEffaced(text: string, all: Word[], rng: () => number): string {
  const lo = EDGE_GUARD_WORDS;
  const hi = all.length - EDGE_GUARD_WORDS - 1;
  if (hi < lo) return text;
  const eligible = hi - lo + 1;
  const count = Math.max(1, Math.min(eligible, Math.round(all.length * 0.03) + 2));

  // Sample `count` distinct indices in [lo, hi] via partial Fisher-Yates over
  // the eligible range, so picks never collide without a rejection loop.
  const pool = Array.from({ length: eligible }, (_, i) => lo + i);
  const chosen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    chosen.add(pool[i]);
  }

  let out = "";
  let cursor = 0;
  for (const idx of [...chosen].sort((a, b) => a - b)) {
    const w = all[idx];
    out += text.slice(cursor, w.start) + damageMark(w.text.length);
    cursor = w.end;
  }
  return out + text.slice(cursor);
}

/**
 * Pick a short phrase and prefix it with itself, growing one word at a time
 * and never reaching full length — a record skipping before it recovers. The
 * phrase's own occurrence in the text is left untouched and doubles as the
 * recovery: nothing is removed, only repeated ahead of itself.
 */
function applyStutter(text: string, all: Word[], rng: () => number): string {
  const phraseLen = 2 + Math.floor(rng() * 3); // 2..4
  const lo = EDGE_GUARD_WORDS;
  const hi = all.length - EDGE_GUARD_WORDS - phraseLen;
  if (hi < lo) return text;
  const start = lo + Math.floor(rng() * (hi - lo + 1));
  const phraseWords = all.slice(start, start + phraseLen).map((w) => w.text);

  const decayed: string[] = [];
  for (let d = 1; d < phraseWords.length; d++) {
    decayed.push(phraseWords.slice(0, d).join(" "));
  }
  if (decayed.length === 0) return text; // phraseLen 1 never happens, but stay safe
  const insertion = decayed.join(" ") + " ";
  return text.slice(0, all[start].start) + insertion + text.slice(all[start].start);
}

export interface DamageResult {
  /** The page as it will be moderated, hashed, and stored. */
  text: string;
  /**
   * The damage actually applied — usually equal to the input, but downgraded
   * to `none` when the page was too short to damage safely. Callers should
   * persist this, not the drawn value, so provenance never claims damage that
   * didn't fire.
   */
  damage: Damage;
}

/**
 * Apply the drawn damage to a page's text. Returns the input unchanged (with
 * `damage: "none"`) whenever the page is too short to guarantee the edge
 * guard on both sides — a short page reads as a deliberate `complete` ending
 * (lib/pageCut.ts), and damaging it besides would compound two rare events
 * into a page that no longer reads as either.
 */
export function applyDamage(raw: string, damage: Damage): DamageResult {
  if (damage === "none") return { text: raw, damage };
  const all = words(raw);
  if (all.length < MIN_WORDS_FOR_DAMAGE) return { text: raw, damage: "none" };

  // Seeded from the text itself — see the header note above `words()`.
  const rng = makeSeededRandom(raw);
  switch (damage) {
    case "lacuna":
      return { text: applyLacuna(raw, all, rng), damage };
    case "effaced":
      return { text: applyEffaced(raw, all, rng), damage };
    case "stutter":
      return { text: applyStutter(raw, all, rng), damage };
  }
}
