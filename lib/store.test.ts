import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  process.env.STALE_RESERVATION_SECONDS = "2";
  process.env.GENERATION_WAIT_SECONDS = "5";
  process.env.WAIT_POLL_INTERVAL_MS = "50";
});

import { closePool, query } from "./db";
import {
  commitPage,
  ensureBook,
  fillBookMetadata,
  getBook,
  getCommittedPages,
  getPage,
  reclaimStaleReservation,
  releaseReservation,
  reservePage,
  setCondensed,
  takeDownPage,
  waitForPage,
} from "./store";

const ADDR = "test-store/1/1/1/1";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  // CASCADE: pages is now FK-referenced by the reader-signal tables (page_likes,
  // engagement); a bare TRUNCATE would error. books is keyed by an address
  // *prefix* (no FK), so it needs its own TRUNCATE.
  await query("TRUNCATE pages CASCADE");
  await query("TRUNCATE books");
});

afterAll(async () => {
  await closePool();
});

describe("reservePage", () => {
  it("grants the reservation to the first caller only", async () => {
    expect(await reservePage(ADDR)).toBe(true);
    expect(await reservePage(ADDR)).toBe(false);
  });

  it("grants exactly one winner under concurrency", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reservePage(ADDR)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("commitPage / getPage", () => {
  it("stores content with its sha256 hash and provenance", async () => {
    await reservePage(ADDR);
    const inputs = {
      model: "test-model",
      temperature: 0.9,
      promptVariant: "base-v6",
      form: "a field guide entry",
      prompt: "the assembled prompt",
      generationMs: 800,
    };
    await commitPage(ADDR, "the text of the page", inputs);
    const row = await getPage(ADDR);
    expect(row?.status).toBe("ok");
    expect(row?.content).toBe("the text of the page");
    expect(row?.content_hash).toBe(
      createHash("sha256").update("the text of the page").digest("hex"),
    );
    // Scalar columns are the projection...
    expect(row?.model).toBe("test-model");
    expect(row?.temperature).toBe(0.9);
    expect(row?.prompt_variant).toBe("base-v6");
    expect(row?.seed_word).toBe("a field guide entry");
    // ...and `inputs` is the whole record, round-tripped through JSONB.
    expect(row?.inputs).toEqual(inputs);
    expect(row?.committed_at).not.toBeNull();
  });

  it("stores a minimal inputs record (just model) with inputs holding only that field", async () => {
    await reservePage(ADDR);
    await commitPage(ADDR, "text", { model: "m" });
    const row = await getPage(ADDR);
    expect(row?.inputs).toEqual({ model: "m" });
  });

  it("returns null for a never-seen address", async () => {
    expect(await getPage("never/1/1/1/1")).toBeNull();
  });

  it("returns true when the commit lands on its reservation", async () => {
    await reservePage(ADDR);
    expect(await commitPage(ADDR, "text", { model: "m" })).toBe(true);
  });

  it("refuses to overwrite a takedown that landed mid-generation", async () => {
    await reservePage(ADDR);
    await takeDownPage(ADDR); // takedown wins the race
    expect(await commitPage(ADDR, "resurrected text", { model: "m" })).toBe(false);
    const row = await getPage(ADDR);
    expect(row?.status).toBe("taken_down");
    expect(row?.content).toBeNull();
  });

  it("reports a lost commit when the reservation was released", async () => {
    await reservePage(ADDR);
    await releaseReservation(ADDR);
    expect(await commitPage(ADDR, "text", { model: "m" })).toBe(false);
    expect(await getPage(ADDR)).toBeNull();
  });

  it("refuses to overwrite an already-committed page", async () => {
    await reservePage(ADDR);
    await commitPage(ADDR, "first", { model: "m" });
    expect(await commitPage(ADDR, "second", { model: "m" })).toBe(false);
    expect((await getPage(ADDR))?.content).toBe("first");
  });
});

describe("reclaimStaleReservation", () => {
  it("does not reclaim a fresh reservation", async () => {
    await reservePage(ADDR);
    expect(await reclaimStaleReservation(ADDR)).toBe(false);
  });

  it("reclaims a reservation older than the stale window", async () => {
    await reservePage(ADDR);
    await query(
      "UPDATE pages SET created_at = now() - interval '10 seconds' WHERE address = $1",
      [ADDR],
    );
    expect(await reclaimStaleReservation(ADDR)).toBe(true);
    // The reclaim resets the clock, so a second reclaimer loses.
    expect(await reclaimStaleReservation(ADDR)).toBe(false);
  });

  it("never reclaims a committed page", async () => {
    await reservePage(ADDR);
    await commitPage(ADDR, "text", { model: "m" });
    await query(
      "UPDATE pages SET created_at = now() - interval '10 seconds' WHERE address = $1",
      [ADDR],
    );
    expect(await reclaimStaleReservation(ADDR)).toBe(false);
  });
});

describe("takeDownPage", () => {
  it("blanks an existing page", async () => {
    await reservePage(ADDR);
    await commitPage(ADDR, "some words", { model: "m" });
    await takeDownPage(ADDR);
    const row = await getPage(ADDR);
    expect(row?.status).toBe("taken_down");
    expect(row?.content).toBeNull();
    expect(row?.content_hash).toBeNull();
  });

  it("pre-emptively blocks a never-generated address (upsert)", async () => {
    expect(await getPage(ADDR)).toBeNull();
    await takeDownPage(ADDR);
    const row = await getPage(ADDR);
    expect(row?.status).toBe("taken_down");
    expect(row?.content).toBeNull();
  });
});

describe("releaseReservation", () => {
  it("removes a generating row", async () => {
    await reservePage(ADDR);
    await releaseReservation(ADDR);
    expect(await getPage(ADDR)).toBeNull();
  });

  it("never removes a committed page", async () => {
    await reservePage(ADDR);
    await commitPage(ADDR, "text", { model: "m" });
    await releaseReservation(ADDR);
    expect((await getPage(ADDR))?.content).toBe("text");
  });
});

describe("books (books experiment)", () => {
  const VOL = "test-store/1/1/1";

  it("ensureBook creates the row with its locked form", async () => {
    const book = await ensureBook(VOL, "a ship's log");
    expect(book.volume_key).toBe(VOL);
    expect(book.form).toBe("a ship's log");
    expect(book.title).toBeNull();
    expect(book.tags).toBeNull();
  });

  it("ensureBook converges concurrent callers on one winner's form", async () => {
    const books = await Promise.all(
      Array.from({ length: 10 }, (_, i) => ensureBook(VOL, `form-${i}`)),
    );
    const forms = new Set(books.map((b) => b.form));
    expect(forms.size).toBe(1);
    expect((await getBook(VOL))?.form).toBe([...forms][0]);
  });

  it("fillBookMetadata fills exactly once", async () => {
    await ensureBook(VOL, "a prayer");
    const prov = { model: "test-model", prompt_variant: "book-v1" };
    expect(await fillBookMetadata(VOL, "The Salt Ledger", ["sea", "debt"], prov)).toBe(true);
    expect(await fillBookMetadata(VOL, "Another Title", ["x"], prov)).toBe(false);
    const book = await getBook(VOL);
    expect(book?.title).toBe("The Salt Ledger");
    expect(book?.tags).toEqual(["sea", "debt"]);
    expect(book?.titled_at).not.toBeNull();
  });

  it("getBook returns null for an unknown volume", async () => {
    expect(await getBook("never/1/1/1")).toBeNull();
  });
});

describe("getCommittedPages / setCondensed", () => {
  const A = "test-store/1/1/1/1";
  const B = "test-store/1/1/1/2";
  const C = "test-store/1/1/1/3";

  it("returns only committed 'ok' rows among the requested addresses", async () => {
    await reservePage(A);
    await commitPage(A, "alpha", { model: "m" });
    await reservePage(B); // still generating
    await reservePage(C);
    await commitPage(C, "gamma", { model: "m" });
    await takeDownPage(C);
    const rows = await getCommittedPages([A, B, C, "never/1/1/1/1"]);
    expect(rows.map((r) => r.address)).toEqual([A]);
  });

  it("returns empty for an empty address list without querying", async () => {
    expect(await getCommittedPages([])).toEqual([]);
  });

  it("setCondensed persists on a committed page only", async () => {
    await reservePage(A);
    await commitPage(A, "alpha", { model: "m" });
    await setCondensed(A, "alpha (condensed)");
    expect((await getPage(A))?.condensed).toBe("alpha (condensed)");

    await reservePage(B); // generating — guard must refuse
    await setCondensed(B, "beta (condensed)");
    expect((await getPage(B))?.condensed).toBeNull();
  });
});

describe("waitForPage", () => {
  it("resolves with the row once the winner commits", async () => {
    await reservePage(ADDR);
    setTimeout(() => {
      void commitPage(ADDR, "committed later", { model: "m" });
    }, 200);
    const row = await waitForPage(ADDR);
    expect(row?.status).toBe("ok");
    expect(row?.content).toBe("committed later");
  });

  it("resolves null once the winner releases", async () => {
    await reservePage(ADDR);
    setTimeout(() => void releaseReservation(ADDR), 200);
    expect(await waitForPage(ADDR)).toBeNull();
  });
});
