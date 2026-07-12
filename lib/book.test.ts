import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  process.env.STALE_RESERVATION_SECONDS = "2";
  process.env.GENERATION_WAIT_SECONDS = "5";
  process.env.WAIT_POLL_INTERVAL_MS = "50";
  // The whole point of this suite: the books experiment switched on.
  process.env.BOOK_MODE = "true";
  // chooseLevers() (page content) and maybeTitleBook/condensePage (aux calls)
  // all draw from the real model_registry pool (lib/registry.ts) in this
  // suite — needs a configured provider key to be eligible.
  process.env.OPENROUTER_API_KEY = "test-key";
});

// Mock only the page-writing LLM call; chooseLevers stays real so the locked
// form and book variant flow through genuine lever selection.
vi.mock("./generate", async () => {
  const actual = await vi.importActual<typeof import("./generate")>("./generate");
  return { ...actual, generatePage: vi.fn() };
});
vi.mock("./moderate", () => ({
  moderate: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./monitor", () => ({ monitor: vi.fn() }));

// The aux LLM calls (condense middle, title/tags) go through the real
// model_registry pool + provider client (lib/registry.ts, lib/providers.ts);
// page content in this suite is kept short so condensation never needs the
// LLM and createMock serves title/tags alone (except where a test says
// otherwise).
const createMock = vi.fn();
vi.mock("./providers", async () => {
  const actual = await vi.importActual<typeof import("./providers")>("./providers");
  return { ...actual, getClient: () => ({ chat: { completions: { create: createMock } } }) };
});

import { closePool, query } from "./db";
import { generatePage } from "./generate";
import { monitor } from "./monitor";
import { resolvePage } from "./resolvePage";
import { getBook, getPage, hashContent } from "./store";

const generateMock = vi.mocked(generatePage);
const monitorMock = vi.mocked(monitor);

/** generatePage result: text + usage. */
const gen = (text: string) => ({
  text,
  model: "mock-model",
  provider: "openrouter" as const,
  usage: { tokens: 100, costUsd: 0 },
});

/** A fake title/tags completion. */
const metadataReply = (content: string) => ({
  choices: [{ message: { content } }],
  usage: { total_tokens: 30 },
});

const GOOD_METADATA = "TITLE: The Salt Ledger\nTAGS: sea, debt, weather";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  // chooseLevers() (page content) and the aux calls (title/tags, condense)
  // all draw from the real model_registry pool — one eligible row suffices;
  // its own selection logic is covered in registry.test.ts / generate.test.ts.
  // ON CONFLICT DO NOTHING: several test files seed this same row into the
  // shared test database (fileParallelism: false runs them sequentially, not
  // isolated), so this must be idempotent regardless of run order.
  await query(
    `INSERT INTO model_registry (slug, provider, task, enabled, weight, temperature, max_tokens)
     VALUES ('mock-model', 'openrouter', 'generation', true, 10, 0.9, 1000)
     ON CONFLICT (slug, task) DO NOTHING`,
  );
});

beforeEach(async () => {
  await query("TRUNCATE pages, rate_limit_hits, monthly_spend CASCADE");
  await query("TRUNCATE books");
  generateMock.mockReset();
  createMock.mockReset();
  monitorMock.mockReset();
  createMock.mockResolvedValue(metadataReply(GOOD_METADATA));
});

afterAll(async () => {
  await closePool();
});

async function seedCommittedPage(address: string, content: string) {
  await query(
    `INSERT INTO pages (address, status, content, content_hash, committed_at)
     VALUES ($1, 'ok', $2, $3, now())`,
    [address, content, hashContent(content)],
  );
}

describe("resolvePage under BOOK_MODE", () => {
  it("first page of a volume creates the book, titles it, and stores its condensation", async () => {
    generateMock.mockResolvedValue(gen("A short page. It ends quickly."));
    const page = await resolvePage("bk/1/1/1/5");
    expect(page.status).toBe("ok");

    const book = await getBook("bk/1/1/1");
    expect(book).not.toBeNull();
    expect(book?.title).toBe("The Salt Ledger");
    expect(book?.tags).toEqual(["sea", "debt", "weather"]);
    expect(book?.prompt_variant).toBe("book-v1");

    const row = await getPage("bk/1/1/1/5");
    expect(row?.prompt_variant).toBe("book-v1");
    // The page was generated under the book's locked form.
    expect(row?.seed_word).toBe(book?.form);
    // Short content is its own condensation, stored post-commit.
    expect(row?.condensed).toBe("A short page. It ends quickly.");
  });

  it("a later page reuses the locked form and receives the prev seam", async () => {
    generateMock.mockResolvedValue(gen("A short page. It ends quickly."));
    await resolvePage("bk/1/1/1/5");
    const book = await getBook("bk/1/1/1");

    generateMock.mockResolvedValue(gen("The tale goes on. Then it rests."));
    await resolvePage("bk/1/1/1/6");

    const levers = generateMock.mock.calls[1][0];
    expect(levers.form).toBe(book?.form);
    expect(levers.promptVariant).toBe("book-v1");
    expect(levers.prev).toBe("A short page. It ends quickly.");
    expect(levers.next).toBeUndefined();
    // The book is already titled — no second metadata call.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect((await getPage("bk/1/1/1/6"))?.seed_word).toBe(book?.form);
  });

  it("bridges when both neighbors are committed", async () => {
    generateMock
      .mockResolvedValueOnce(gen("Page five stands alone. It waits."))
      .mockResolvedValueOnce(gen("Page seven stands apart. It waits too."))
      .mockResolvedValueOnce(gen("Page six sits between. It joins them."));
    await resolvePage("bk/1/1/1/5");
    await resolvePage("bk/1/1/1/7");
    await resolvePage("bk/1/1/1/6");

    const levers = generateMock.mock.calls[2][0];
    expect(levers.prev).toBe("Page five stands alone. It waits.");
    expect(levers.next).toBe("Page seven stands apart. It waits too.");
  });

  it("condenses a pre-book-mode neighbor lazily and persists it", async () => {
    await seedCommittedPage("bk/1/1/1/5", "An old page. From before books.");
    expect((await getPage("bk/1/1/1/5"))?.condensed).toBeNull();

    generateMock.mockResolvedValue(gen("A new page. It follows the old."));
    await resolvePage("bk/1/1/1/6");

    const levers = generateMock.mock.calls[0][0];
    expect(levers.prev).toBe("An old page. From before books.");
    // The lazy condensation was written back.
    expect((await getPage("bk/1/1/1/5"))?.condensed).toBe(
      "An old page. From before books.",
    );
  });

  it("an unparseable title reply leaves the book untitled; the next page retries", async () => {
    createMock
      .mockResolvedValueOnce(metadataReply("I refuse to follow formats."))
      .mockResolvedValueOnce(metadataReply(GOOD_METADATA));
    generateMock.mockResolvedValue(gen("A short page. It ends quickly."));

    await resolvePage("bk/1/1/1/5");
    expect((await getBook("bk/1/1/1"))?.title).toBeNull();
    expect((await getPage("bk/1/1/1/5"))?.status).toBe("ok");

    generateMock.mockResolvedValue(gen("Another page. Also short."));
    await resolvePage("bk/1/1/1/6");
    expect((await getBook("bk/1/1/1"))?.title).toBe("The Salt Ledger");
  });

  it("a failing title/tags call never blocks the page and flags a monitor event", async () => {
    createMock.mockRejectedValue(new Error("429 rate limited"));
    generateMock.mockResolvedValue(gen("A short page. It ends quickly."));

    const page = await resolvePage("bk/1/1/1/5");
    expect(page.status).toBe("ok");
    expect((await getPage("bk/1/1/1/5"))?.status).toBe("ok");
    expect((await getBook("bk/1/1/1"))?.title).toBeNull();
    expect(monitorMock).toHaveBeenCalledWith(
      "book_metadata_failed",
      expect.objectContaining({ volumeKey: "bk/1/1/1" }),
    );
  });

  it("counts aux calls (title/tags) into the monthly spend", async () => {
    generateMock.mockResolvedValue(gen("A short page. It ends quickly."));
    await resolvePage("bk/1/1/1/5");
    const rows = await query<{ tokens: string }>(
      "SELECT tokens FROM monthly_spend WHERE month = $1",
      [new Date().toISOString().slice(0, 7)],
    );
    // 100 generation tokens + 30 metadata tokens (condensation was free —
    // short middle, no LLM call).
    expect(Number(rows[0]?.tokens)).toBe(130);
  });
});
