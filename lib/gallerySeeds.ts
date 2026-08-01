import { query } from "./db";
import { devLog } from "./log";
import { monitor } from "./monitor";
import { getClient, reasoningParams } from "./providers";
import { chooseGenerationModel } from "./registry";
import { getModelStats } from "./modelStats";

/**
 * Gallery association seeds — the subject-side entropy lever
 * (docs/reference/generation.md).
 *
 * Temperature widens the distribution a page is drawn from; it does not move
 * it. Every page drawing from the same distribution is why the twentieth page
 * reads like the first. A *subject* moves it — so each gallery token is
 * expanded once, on the first generation inside it, into ~50 associated terms,
 * and each volume draws one of them to build its pages around.
 *
 * The gallery is the only part of the address that carries meaning (a visitor
 * types it), so it is the only part worth associating from. `bmw89` grows a
 * neighbourhood where a few volumes are plainly about BMW and most are
 * connected only sideways — a real library's texture, and the connection is
 * meant to be *perceptible*, not hidden.
 *
 * ## What this changes about the address invariant
 *
 * The prompt still never contains the address, and lib/prompts.test.ts still
 * enforces that — the page sees `oak bark`, never `bmw89` and never a
 * coordinate. But the gallery token's *meaning* now reaches the model, where
 * before it was inert. That makes the URL a user-controlled input to
 * generation, so treat the expansion prompt below as the trust boundary: it is
 * written to yield ordinary, oblique nouns from any token, hostile ones
 * included. There is deliberately no denylist (12 chars of [a-z0-9-] cannot
 * carry an instruction, and a denylist is trivially routed around); the
 * mitigation is that terms are *stored*, so a bad expansion is inspectable and
 * `DELETE FROM gallery_seeds WHERE gallery = '...'` is the whole fix.
 *
 * ## Why this is not GENERATION_FORMS again
 *
 * The removed forms lever (commit 6d613cc) prescribed a *register* — "reads
 * like a prayer" — and produced pastiche, because a style label is an
 * imitation target. A subject is not a style: "oak bark" says nothing about
 * what kind of text this is, leaving the model to invent that. Keep the
 * expansion prompt on subject matter and off text-types; lib/gallerySeeds.test.ts
 * guards the line.
 */

/** How many associations to ask for. */
const TERM_COUNT = 50;

/**
 * Asking for many at once is what produces the range: a model hands over the
 * obvious dozen first and has to reach for the rest, so a single call spans
 * on-the-nose to oblique without anyone labelling bands. Explicitly allowing
 * nonsense tokens matters — most galleries are typed by hand and mean nothing
 * (`io-9`, `x7k2`), and sound/shape association is the only route in.
 */
function expansionPrompt(gallery: string): string {
  return [
    `Free-associate from this token: "${gallery}"`,
    "",
    `List ${TERM_COUNT} things it brings to mind — some obvious, most further ` +
      "away. If the token means nothing, work from its sound, its shape, or " +
      "the things its parts resemble.",
    "",
    "Each entry is a subject: a thing, a material, a place, an occupation, a " +
      "phenomenon. Never a kind of writing — no 'poem', 'diary', 'manual', " +
      "'report'. Concrete beats abstract: 'kiln' over 'transformation'.",
    "",
    "Answer with the list only, one per line, no numbering or commentary.",
  ].join("\n");
}

/** Cap on a single term, so one runaway line can't dominate a prompt. */
const MAX_TERM_LENGTH = 60;

/**
 * Hard ceiling on how many terms are kept, regardless of what came back.
 * Asking for 50 is a request, not a constraint: a probe run against
 * deepseek-v4-flash returned **332** terms for `amber`, and quality decayed
 * badly down the tail (the last hundred were abstractions like "eternity",
 * "longing", "stillness"). Truncating keeps the good head of the list.
 */
const MAX_TERMS = TERM_COUNT * 2;

/**
 * Text-type nouns, dropped on sight.
 *
 * This is the GENERATION_FORMS failure (commit 6d613cc) trying to come back in
 * through the side door, and it is not hypothetical: the same probe run
 * produced "manuscript", "scroll", "fable" and "tale" as terms, despite the
 * expansion prompt explicitly forbidding kinds of writing. Seeding a page with
 * "fable" is exactly the register label that produced pastiche and got that
 * lever deleted.
 *
 * A denylist is crude, but here it is a net under a prompt that already asks
 * for the right thing, over a small closed vocabulary — not the primary
 * mechanism, and not the security boundary (that is the expansion prompt
 * itself, see the header).
 */
const TEXT_TYPES = new Set([
  "poem", "poetry", "diary", "journal", "manual", "report", "letter", "essay",
  "novel", "story", "tale", "fable", "myth", "legend", "manuscript",
  "scripture", "verse", "prose", "sonnet", "haiku", "ballad", "elegy", "ode",
  "prayer", "sermon", "hymn", "psalm", "treatise", "chronicle", "almanac",
  "catalogue", "catalog", "inventory", "ledger", "recipe", "memoir",
  "biography", "transcript", "dossier", "monograph", "anthology", "novella",
  "script", "screenplay", "libretto", "epitaph", "riddle", "proverb",
]);

/**
 * Parse the model's list into clean terms. Models decorate lists even when
 * told not to, so strip numbering and bullets, and drop anything
 * suspiciously long — a term is a noun phrase, not a sentence.
 */
export function parseTerms(raw: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const line of raw.split("\n")) {
    const cleaned = line
      .replace(/^\s*[-*•]\s*/, "")
      .replace(/^\s*\d+[.)]\s*/, "")
      .trim()
      .replace(/[.,;]$/, "");
    if (!cleaned || cleaned.length > MAX_TERM_LENGTH) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key) || TEXT_TYPES.has(key)) continue;
    seen.add(key);
    terms.push(cleaned);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

/**
 * How long an instance waits before trying a failed gallery again.
 *
 * The stored row is the real cache, but a gallery that has *no* row yet
 * retries the model call on every attempt — and a page that fails moderation
 * re-runs chooseLevers twice more within the same request, so one bad gallery
 * would fire three association calls for one page. This bounds it to one
 * attempt per gallery per window per instance. Failing open means the cost of
 * waiting is only that a few early pages generate unseeded.
 */
const RETRY_AFTER_FAILURE_MS = 60_000;

const lastFailure = new Map<string, number>();

interface SeedRow {
  terms: string[];
}

async function storedTerms(gallery: string): Promise<string[] | null> {
  const rows = await query<SeedRow>(
    "SELECT terms FROM gallery_seeds WHERE gallery = $1",
    [gallery],
  );
  return rows[0]?.terms ?? null;
}

/**
 * The association terms for a gallery, minting them on first use.
 *
 * **Fails open, always.** A provider outage, a timeout, an unparseable answer
 * — every one of them returns `[]`, and the caller generates exactly as it did
 * before this lever existed. Nothing partial is written, so the next visit
 * retries. A page must never fail to exist because its gallery could not be
 * associated from.
 *
 * The insert is `ON CONFLICT DO NOTHING` followed by a re-read rather than a
 * reservation: two readers racing the first page of a fresh gallery both call
 * the model, one row wins, and both then read the winner. That wastes one call
 * at most once per gallery — much cheaper than the reservation machinery pages
 * need, and the outcome is identical either way.
 */
export async function termsForGallery(gallery: string): Promise<string[]> {
  try {
    const existing = await storedTerms(gallery);
    if (existing) return existing;

    const failedAt = lastFailure.get(gallery);
    if (failedAt !== undefined && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS) {
      return [];
    }

    const stats = await getModelStats();
    const chosen = await chooseGenerationModel(stats);
    const client = getClient(chosen.provider);
    if (!client) return [];

    const response = await client.chat.completions.create({
      model: chosen.slug,
      temperature: chosen.temperature,
      max_tokens: chosen.maxTokens,
      messages: [{ role: "user", content: expansionPrompt(gallery) }],
      ...reasoningParams(chosen.provider),
    });

    const terms = parseTerms(response.choices[0]?.message.content ?? "");
    // An empty or near-empty expansion is a failed call, not a gallery with
    // nothing to say. Storing it would make the emptiness permanent.
    if (terms.length < 5) {
      devLog(`gallerySeeds ${gallery} → ${terms.length} terms, too few → unseeded`);
      lastFailure.set(gallery, Date.now());
      return [];
    }

    await query(
      "INSERT INTO gallery_seeds (gallery, terms, model) VALUES ($1, $2, $3) " +
        "ON CONFLICT (gallery) DO NOTHING",
      [gallery, JSON.stringify(terms), chosen.slug],
    );
    // Re-read so a racing writer's row wins consistently for both callers.
    const committed = (await storedTerms(gallery)) ?? terms;
    lastFailure.delete(gallery);
    devLog(`gallerySeeds ${gallery} → ${committed.length} terms via ${chosen.slug}`);
    return committed;
  } catch (error) {
    // Never surface as a page failure — log for visibility and carry on
    // unseeded.
    lastFailure.set(gallery, Date.now());
    await monitor("gallery_seed_failed", {
      gallery,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * The term a given volume builds its pages around, or undefined if the gallery
 * has no terms. `rng` must come from lib/seededRandom.ts's volumeSeed stream,
 * so every page of the volume lands on the same term.
 */
export function pickTerm(
  terms: readonly string[],
  rng: () => number,
): string | undefined {
  if (terms.length === 0) return undefined;
  return terms[Math.floor(rng() * terms.length)];
}
