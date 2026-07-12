import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  // Small throttle ceiling so the admission test is quick to exhaust.
  process.env.ENGAGEMENT_RATE_LIMIT_PER_MINUTE = "3";
  process.env.ENGAGEMENT_RATE_LIMIT_WINDOW_SECONDS = "60";
});

import { closePool, query } from "./db";
import {
  admitEngagementWrite,
  canonicalizeAddress,
  dislikeLeaf,
  getDislikeCount,
  getLikeCount,
  pressLeaf,
  recordDwell,
} from "./engagement";

const ADDR = "test-eng/1/1/1/1";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query(
    "TRUNCATE pages, page_likes, page_dislikes, engagement, engagement_rate_limit_hits CASCADE",
  );
  // The signal tables FK to pages(address); marks only ever attach to a
  // committed leaf, so give the tests a real page row.
  await query("INSERT INTO pages (address, status) VALUES ($1, 'ok')", [ADDR]);
});

afterAll(async () => {
  await closePool();
});

describe("canonicalizeAddress", () => {
  it("returns the canonical string for a valid address", () => {
    expect(canonicalizeAddress("io-9/3/2/17/308")).toBe("io-9/3/2/17/308");
  });

  it("lower-cases the gallery token", () => {
    expect(canonicalizeAddress("IO-9/3/2/17/308")).toBe("io-9/3/2/17/308");
  });

  it("rejects non-canonical numerics (leading zero) and out-of-range", () => {
    expect(canonicalizeAddress("io-9/03/2/17/308")).toBeNull();
    expect(canonicalizeAddress("io-9/9/2/17/308")).toBeNull(); // wall > 4
  });

  it("rejects malformed input", () => {
    expect(canonicalizeAddress("io-9/3/2/17")).toBeNull(); // too few segments
    expect(canonicalizeAddress("")).toBeNull();
    expect(canonicalizeAddress(42)).toBeNull();
    expect(canonicalizeAddress(undefined)).toBeNull();
  });
});

describe("pressLeaf / getLikeCount", () => {
  it("starts at zero", async () => {
    expect(await getLikeCount(ADDR)).toBe(0);
  });

  it("increments on press and decrements on un-press", async () => {
    expect(await pressLeaf(ADDR, true)).toBe(1);
    expect(await pressLeaf(ADDR, true)).toBe(2);
    expect(await getLikeCount(ADDR)).toBe(2);
    expect(await pressLeaf(ADDR, false)).toBe(1);
    expect(await getLikeCount(ADDR)).toBe(1);
  });

  it("never drops below zero", async () => {
    expect(await pressLeaf(ADDR, false)).toBe(0);
    expect(await pressLeaf(ADDR, false)).toBe(0);
  });
});

describe("dislikeLeaf / getDislikeCount", () => {
  it("starts at zero", async () => {
    expect(await getDislikeCount(ADDR)).toBe(0);
  });

  it("increments on mark and decrements on unmark", async () => {
    expect(await dislikeLeaf(ADDR, true)).toBe(1);
    expect(await dislikeLeaf(ADDR, true)).toBe(2);
    expect(await getDislikeCount(ADDR)).toBe(2);
    expect(await dislikeLeaf(ADDR, false)).toBe(1);
    expect(await getDislikeCount(ADDR)).toBe(1);
  });

  it("never drops below zero", async () => {
    expect(await dislikeLeaf(ADDR, false)).toBe(0);
    expect(await dislikeLeaf(ADDR, false)).toBe(0);
  });

  it("does not touch the like counter", async () => {
    await dislikeLeaf(ADDR, true);
    expect(await getLikeCount(ADDR)).toBe(0);
  });
});

describe("recordDwell", () => {
  async function dwellRows(): Promise<
    { dwell_ms: number | null; arrived_via: string | null }[]
  > {
    return query("SELECT dwell_ms, arrived_via FROM engagement WHERE address = $1", [
      ADDR,
    ]);
  }

  it("stores a bounded dwell with a known arrived_via", async () => {
    await recordDwell(ADDR, 12345, "random");
    const rows = await dwellRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dwell_ms).toBe(12345);
    expect(rows[0].arrived_via).toBe("random");
  });

  it("nulls an unknown arrived_via", async () => {
    await recordDwell(ADDR, 1000, "sideways");
    expect((await dwellRows())[0].arrived_via).toBeNull();
  });

  it("drops negative, non-finite, and absurd dwell without inserting", async () => {
    await recordDwell(ADDR, -5);
    await recordDwell(ADDR, Number.NaN);
    await recordDwell(ADDR, 7 * 60 * 60 * 1000); // > 6h cap
    expect(await dwellRows()).toHaveLength(0);
  });
});

describe("admitEngagementWrite", () => {
  const IP = "203.0.113.7";

  it("admits without an IP (no throttle key)", async () => {
    expect(await admitEngagementWrite(undefined)).toBe(true);
  });

  it("admits up to the ceiling then refuses within the window", async () => {
    expect(await admitEngagementWrite(IP)).toBe(true);
    expect(await admitEngagementWrite(IP)).toBe(true);
    expect(await admitEngagementWrite(IP)).toBe(true);
    expect(await admitEngagementWrite(IP)).toBe(false); // 4th over ceiling of 3
  });
});
