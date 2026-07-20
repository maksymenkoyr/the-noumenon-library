import { createHash } from "node:crypto";
import { config } from "./config";
import { query } from "./db";
import type { Provider } from "./providers";

/**
 * The page store: generate-once, store-forever (docs/reference/architecture.md §2–§3, §8).
 * All functions key on the canonical normalized address (lib/address.ts).
 */

export type PageStatus = "generating" | "ok" | "taken_down";

export interface PageRow {
  address: string;
  status: PageStatus;
  content: string | null;
  content_hash: string | null;
  model: string | null;
  prompt_variant: string | null;
  temperature: number | null;
  seed_word: string | null;
  created_at: Date;
  committed_at: Date | null;
  // Reverse-bell-curve digest for neighbor context (docs/reference/books.md); NULL for
  // pre-book-mode pages until condensed lazily on first neighbor read.
  condensed: string | null;
  // The full generation-inputs record (see PageInputs below). NULL for rows
  // committed before this column existed — readers degrade to the scalar
  // provenance columns above.
  inputs: PageInputs | null;
}

/**
 * The unified generation-inputs entity — everything that went into producing
 * a page: the exact prompt, the entropy levers, and moderation/timing
 * metadata. Persisted whole in pages.inputs (JSONB) by commitPage, and read
 * back on revisit so the dev overlay isn't fresh-generation-only. The scalar
 * provenance columns (model, prompt_variant, temperature, seed_word) are a
 * projection of this object, written from the same value at commit so the
 * two can never drift. All fields but `model` are optional: minimal callers
 * (older tests, book title/tag calls) may commit with just a model.
 */
export interface PageInputs {
  model: string;
  provider?: Provider;
  temperature?: number;
  // provenanceVariant(levers) — includes `+id` suffixes for applied constraints.
  promptVariant?: string;
  // The seed_word value: the book's locked form, or else the sampled axis
  // fingerprint (base-v5).
  form?: string;
  // Applied constraint ids (unsuffixed), for structured querying.
  constraints?: string[];
  // The exact prompt sent for whichever attempt ended up committed.
  prompt?: string;
  // The chain link that passed the committed content (lib/moderate.ts).
  moderationModel?: string;
  generationMs?: number;
  moderationMs?: number;
}

/** SHA-256 of page content — the dedup key (docs/reference/architecture.md §8). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Whether identical content already exists at a different address. Exact
 * collisions only — near-duplicates are allowed by design (§8).
 */
export async function contentExistsElsewhere(
  contentHash: string,
  address: string,
): Promise<boolean> {
  const rows = await query(
    "SELECT 1 FROM pages WHERE content_hash = $1 AND address <> $2 LIMIT 1",
    [contentHash, address],
  );
  return rows.length > 0;
}

export async function getPage(address: string): Promise<PageRow | null> {
  const rows = await query<PageRow>(
    "SELECT * FROM pages WHERE address = $1",
    [address],
  );
  return rows[0] ?? null;
}

/**
 * Attempt to win generation for a never-seen address. Exactly one of N
 * concurrent callers gets true; the rest must wait for the winner (§3).
 */
export async function reservePage(address: string): Promise<boolean> {
  const rows = await query(
    `INSERT INTO pages (address, status)
     VALUES ($1, 'generating')
     ON CONFLICT (address) DO NOTHING
     RETURNING address`,
    [address],
  );
  return rows.length > 0;
}

/**
 * Take over a reservation whose owner has presumably crashed, so an
 * abandoned generation never wedges an address permanently (§3). Returns
 * true if this caller now owns generation. Atomic: the age check and the
 * timestamp reset happen in one statement, so only one reclaimer wins.
 */
export async function reclaimStaleReservation(
  address: string,
): Promise<boolean> {
  const rows = await query(
    `UPDATE pages SET created_at = now()
     WHERE address = $1
       AND status = 'generating'
       AND created_at < now() - make_interval(secs => $2)
     RETURNING address`,
    [address, config.staleReservationSeconds],
  );
  return rows.length > 0;
}

/**
 * Write the final page state and release the reservation. Returns whether a
 * row was actually committed. Guarded to 'generating' rows so a commit can
 * only ever complete the reservation it belongs to: a takedown that landed
 * mid-generation is never resurrected to 'ok' (docs/reference/legal.md), and a
 * reservation released or reclaimed by another request isn't overwritten.
 * On false the caller must not present its content as committed.
 */
export async function commitPage(
  address: string,
  content: string,
  inputs: PageInputs,
): Promise<boolean> {
  const contentHash = hashContent(content);
  // The scalar columns are a projection of `inputs`, written from the same
  // object so they can't drift apart (docs/reference/generation.md).
  const rows = await query(
    `UPDATE pages SET
       status = 'ok',
       content = $2,
       content_hash = $3,
       model = $4,
       prompt_variant = $5,
       temperature = $6,
       seed_word = $7,
       inputs = $8::jsonb,
       committed_at = now()
     WHERE address = $1 AND status = 'generating'
     RETURNING address`,
    [
      address,
      content,
      contentHash,
      inputs.model,
      inputs.promptVariant ?? null,
      inputs.temperature ?? null,
      inputs.form ?? null,
      JSON.stringify(inputs),
    ],
  );
  return rows.length > 0;
}

/**
 * Reactive takedown (docs/reference/legal.md): blank an address by report. Upserts so it
 * works whether or not the page was ever generated (enabling pre-emptive
 * blocks). The content stops being served immediately and never regenerates.
 */
export async function takeDownPage(address: string): Promise<void> {
  await query(
    `INSERT INTO pages (address, status, committed_at)
     VALUES ($1, 'taken_down', now())
     ON CONFLICT (address) DO UPDATE SET
       status = 'taken_down',
       content = NULL,
       content_hash = NULL,
       committed_at = now()`,
    [address],
  );
}

/**
 * Drop a reservation after a failed generation so the address is not
 * wedged until the stale-reclaim window passes; the next visitor simply
 * becomes the new first visitor.
 */
export async function releaseReservation(address: string): Promise<void> {
  await query(
    "DELETE FROM pages WHERE address = $1 AND status = 'generating'",
    [address],
  );
}

// --- Books experiment (docs/reference/books.md): volume = book -----------------------

export interface BookRow {
  volume_key: string;
  form: string;
  title: string | null;
  tags: string[] | null;
  model: string | null;
  prompt_variant: string | null;
  created_at: Date;
  titled_at: Date | null;
}

export async function getBook(volumeKey: string): Promise<BookRow | null> {
  const rows = await query<BookRow>(
    "SELECT * FROM books WHERE volume_key = $1",
    [volumeKey],
  );
  return rows[0] ?? null;
}

/**
 * Create-or-get a book row, locking its form at creation. Race-safe the same
 * way reservePage is: of N concurrent first-pages in a volume, exactly one
 * INSERT wins and everyone re-reads the winner's form.
 */
export async function ensureBook(
  volumeKey: string,
  form: string,
): Promise<BookRow> {
  const rows = await query<BookRow>(
    `INSERT INTO books (volume_key, form)
     VALUES ($1, $2)
     ON CONFLICT (volume_key) DO NOTHING
     RETURNING *`,
    [volumeKey, form],
  );
  if (rows[0]) return rows[0];
  const existing = await getBook(volumeKey);
  if (!existing) throw new Error(`Book vanished after conflict: ${volumeKey}`);
  return existing;
}

/**
 * Fill title/tags exactly once (from the book's first committed page). The
 * `title IS NULL` guard makes concurrent fillers race safely — returns whether
 * this caller won. A parse/LLM failure upstream simply leaves title NULL, and
 * the next page generated in the volume retries.
 */
export async function fillBookMetadata(
  volumeKey: string,
  title: string,
  tags: string[],
  provenance: { model: string; prompt_variant: string },
): Promise<boolean> {
  const rows = await query(
    `UPDATE books SET
       title = $2,
       tags = $3,
       model = $4,
       prompt_variant = $5,
       titled_at = now()
     WHERE volume_key = $1 AND title IS NULL
     RETURNING volume_key`,
    [volumeKey, title, tags, provenance.model, provenance.prompt_variant],
  );
  return rows.length > 0;
}

/**
 * Committed pages among the given addresses, one query. Only 'ok' rows —
 * a neighbor mid-generation or taken down contributes no continuity context.
 */
export async function getCommittedPages(
  addresses: string[],
): Promise<PageRow[]> {
  if (addresses.length === 0) return [];
  return query<PageRow>(
    "SELECT * FROM pages WHERE address = ANY($1) AND status = 'ok'",
    [addresses],
  );
}

/**
 * Persist a page's condensation (post-commit or lazily on neighbor read).
 * Guarded to 'ok' rows so a takedown between read and write can't resurrect
 * content into the condensed column.
 */
export async function setCondensed(
  address: string,
  condensed: string,
): Promise<void> {
  await query(
    "UPDATE pages SET condensed = $2 WHERE address = $1 AND status = 'ok'",
    [address, condensed],
  );
}

/**
 * Wait for another request's in-flight generation to finish (§3,
 * wait-for-winner). Resolves with the committed row, or null if the wait
 * times out or the winner released its reservation.
 */
export async function waitForPage(address: string): Promise<PageRow | null> {
  const deadline = Date.now() + config.generationWaitSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, config.waitPollIntervalMs),
    );
    const row = await getPage(address);
    if (!row || row.status !== "generating") return row;
  }
  return null;
}
