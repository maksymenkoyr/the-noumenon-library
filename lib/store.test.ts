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
  getPage,
  reclaimStaleReservation,
  releaseReservation,
  reservePage,
  takeDownPage,
  waitForPage,
} from "./store";

const ADDR = "test-store/1/1/1/1";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  // CASCADE: pages is now FK-referenced by the reader-signal tables (page_likes,
  // engagement); a bare TRUNCATE would error.
  await query("TRUNCATE pages CASCADE");
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
    await commitPage(ADDR, "the text of the page", {
      model: "test-model",
      temperature: 0.9,
    });
    const row = await getPage(ADDR);
    expect(row?.status).toBe("ok");
    expect(row?.content).toBe("the text of the page");
    expect(row?.content_hash).toBe(
      createHash("sha256").update("the text of the page").digest("hex"),
    );
    expect(row?.model).toBe("test-model");
    expect(row?.temperature).toBe(0.9);
    expect(row?.committed_at).not.toBeNull();
  });

  it("returns null for a never-seen address", async () => {
    expect(await getPage("never/1/1/1/1")).toBeNull();
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
