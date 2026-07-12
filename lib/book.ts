import {
  formatAddress,
  nextPageInVolume,
  prevPageInVolume,
  volumeKey,
  type Address,
} from "./address";
import { condensePage } from "./condense";
import { config } from "./config";
import type { GenerationUsage } from "./economics";
import { devLog } from "./log";
import { getModelStats } from "./modelStats";
import { monitor } from "./monitor";
import { getClient, reasoningParams } from "./providers";
import {
  BOOK_PROMPT_VARIANT,
  GENERATION_FORMS,
  buildBookMetadataPrompt,
  parseBookMetadata,
} from "./prompts";
import { chooseGenerationModel } from "./registry";
import {
  ensureBook,
  fillBookMetadata,
  getCommittedPages,
  setCondensed,
  type BookRow,
  type PageRow,
} from "./store";

/**
 * Book orchestration for the books experiment (docs/books.md): the one module
 * that knows the whole story — volume = book, a form locked at book creation,
 * neighbor continuity via condensed committed pages, and title/tags invented
 * from the first committed page. pipeline.ts and resolvePage.ts stay thin.
 */

export interface BookContext {
  volumeKey: string;
  book: BookRow; // book.form is the locked register for every page
  prev?: string; // condensed prev-in-volume, when committed
  next?: string; // condensed next-in-volume, when committed
}

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * A neighbor's condensed text, computing and persisting it lazily for pages
 * that predate book mode (or whose post-commit condensation write failed).
 * Aux LLM cost is accumulated into `usage`. Degrades, never throws for
 * condensation reasons — a failed persist still returns usable context.
 */
async function neighborCondensed(
  row: PageRow,
  usage: GenerationUsage,
): Promise<string | undefined> {
  if (row.condensed) return row.condensed;
  if (!row.content) return undefined;
  const { condensed, usage: condenseUsage } = await condensePage(row.content);
  usage.tokens += condenseUsage.tokens;
  usage.costUsd += condenseUsage.costUsd;
  try {
    await setCondensed(row.address, condensed);
  } catch (error) {
    devLog(
      `book: failed to persist lazy condensation of ${row.address}:`,
      error instanceof Error ? error.message : error,
    );
  }
  return condensed;
}

/**
 * Everything book-mode generation needs before the LLM call: the book row
 * (created here on the volume's first generation, locking its form) and the
 * condensed committed neighbors. Two adjacent pages generating simultaneously
 * don't see each other (the 'ok' filter) — an accepted, eventual seam miss.
 * DB errors propagate (the caller releases the reservation and retries later,
 * same as any pre-commit failure).
 */
export async function resolveBookContext(
  addr: Address,
  usage: GenerationUsage,
): Promise<BookContext> {
  const key = volumeKey(addr);
  const book = await ensureBook(key, pick(GENERATION_FORMS));

  const prevAddr = prevPageInVolume(addr);
  const nextAddr = nextPageInVolume(addr);
  const wanted = [prevAddr, nextAddr]
    .filter((a): a is Address => a !== null)
    .map(formatAddress);
  const rows = await getCommittedPages(wanted);
  const byAddress = new Map(rows.map((row) => [row.address, row]));

  const prevRow = prevAddr ? byAddress.get(formatAddress(prevAddr)) : undefined;
  const nextRow = nextAddr ? byAddress.get(formatAddress(nextAddr)) : undefined;
  const prev = prevRow ? await neighborCondensed(prevRow, usage) : undefined;
  const next = nextRow ? await neighborCondensed(nextRow, usage) : undefined;

  devLog(
    `book ${key} form="${book.form}" prev=${prev ? "yes" : "no"} next=${next ? "yes" : "no"}`,
  );
  return { volumeKey: key, book, prev, next };
}

/**
 * Post-commit, best-effort: invent the book's title and tags from its first
 * committed page. Fill-once (store guard), so late concurrent callers lose
 * quietly. Every failure — LLM, parse, DB — is swallowed and the book stays
 * untitled; the next page generated in the volume retries. Never throws.
 */
export async function maybeTitleBook(
  book: BookRow,
  pageContent: string,
  usage: GenerationUsage,
): Promise<void> {
  if (book.title) return;
  try {
    // Draws from the same weighted generation pool as page content (lib/
    // registry.ts) rather than a bare uniform pick — title/tags is still a
    // best-effort aux call (degrades to untitled on any failure below), but
    // now respects the pool's health/enabled state too.
    const chosen = await chooseGenerationModel(await getModelStats());
    const client = getClient(chosen.provider);
    if (!client) throw new Error(`No client for provider: ${chosen.provider}`);
    const response = await client.chat.completions.create({
      model: chosen.slug,
      temperature: 0.7,
      // Cost backstop only.
      max_tokens: config.maxTokens,
      messages: [
        { role: "user", content: buildBookMetadataPrompt(pageContent) },
      ],
      ...reasoningParams(chosen.provider),
    });
    const tokens = response.usage?.total_tokens ?? 0;
    usage.tokens += tokens;
    usage.costUsd += (tokens / 1_000_000) * (config.modelPrices[chosen.slug] ?? 0);

    const parsed = parseBookMetadata(response.choices[0]?.message.content);
    if (!parsed) {
      devLog(
        `book ${book.volume_key}: unparseable title reply — a later page retries`,
      );
      return;
    }
    const won = await fillBookMetadata(book.volume_key, parsed.title, parsed.tags, {
      model: chosen.slug,
      prompt_variant: BOOK_PROMPT_VARIANT,
    });
    if (won) {
      devLog(
        `book ${book.volume_key} titled "${parsed.title}" tags=[${parsed.tags.join(", ")}]`,
      );
    }
  } catch (error) {
    devLog(
      `book ${book.volume_key}: title/tags failed — a later page retries:`,
      error instanceof Error ? error.message : error,
    );
    void monitor("book_metadata_failed", {
      volumeKey: book.volume_key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
