import { randomUUID } from "node:crypto";
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
  recordEvents,
  type RawEvent,
} from "./engagement";

const ADDR = "test-eng/1/1/1/1";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query(
    "TRUNCATE pages, page_likes, page_dislikes, engagement, engagement_rate_limit_hits, page_events CASCADE",
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

describe("recordEvents", () => {
  async function engagementRow(
    loadId: string,
  ): Promise<{ dwell_ms: number | null; arrived_via: string | null } | undefined> {
    const rows = await query<{ dwell_ms: number | null; arrived_via: string | null }>(
      "SELECT dwell_ms, arrived_via FROM engagement WHERE load_id = $1",
      [loadId],
    );
    return rows[0];
  }

  async function pageEventRows(
    loadId: string,
  ): Promise<{ event: string; seq: number }[]> {
    return query(
      "SELECT event, seq FROM page_events WHERE load_id = $1 ORDER BY seq ASC",
      [loadId],
    );
  }

  it("records a normal visible->hidden sequence as page_events plus one engagement row", async () => {
    const loadId = randomUUID();
    const events: RawEvent[] = [
      { e: "arrive", t: 0, seq: 0, via: "random" },
      { e: "visible", t: 0, seq: 1 },
      { e: "hidden", t: 4000, seq: 2 },
    ];
    await recordEvents(ADDR, loadId, events, "desktop");

    const rows = await pageEventRows(loadId);
    expect(rows.map((r) => r.event)).toEqual(["arrive", "visible", "hidden"]);

    const row = await engagementRow(loadId);
    expect(row?.dwell_ms).toBe(4000);
    expect(row?.arrived_via).toBe("random");
  });

  it("excludes an idle->active gap from dwell_ms", async () => {
    const loadId = randomUUID();
    const events: RawEvent[] = [
      { e: "arrive", t: 0, seq: 0 },
      { e: "visible", t: 0, seq: 1 },
      { e: "idle", t: 60000, seq: 2 }, // 60s counted
      { e: "active", t: 65000, seq: 3 }, // 5s idle gap excluded
      { e: "hidden", t: 70000, seq: 4 }, // 5s counted
    ];
    await recordEvents(ADDR, loadId, events, null);

    const row = await engagementRow(loadId);
    expect(row?.dwell_ms).toBe(65000); // 60000 + 5000, not the full 70000
  });

  it("is idempotent when the same events are sent twice (a re-sent tail beacon)", async () => {
    const loadId = randomUUID();
    const events: RawEvent[] = [
      { e: "arrive", t: 0, seq: 0 },
      { e: "visible", t: 0, seq: 1 },
      { e: "hidden", t: 3000, seq: 2 },
    ];
    await recordEvents(ADDR, loadId, events, null);
    await recordEvents(ADDR, loadId, events, null); // duplicate flush

    expect(await pageEventRows(loadId)).toHaveLength(3); // no duplicate rows
    expect((await engagementRow(loadId))?.dwell_ms).toBe(3000); // not doubled
  });

  it("upserts the same engagement row when a later beacon adds new events for the same loadId", async () => {
    const loadId = randomUUID();
    await recordEvents(
      ADDR,
      loadId,
      [
        { e: "arrive", t: 0, seq: 0 },
        { e: "visible", t: 0, seq: 1 },
      ],
      null,
    );
    await recordEvents(ADDR, loadId, [{ e: "hidden", t: 9000, seq: 2 }], null);

    const rows = await query<{ count: string }>(
      "SELECT count(*) FROM engagement WHERE load_id = $1",
      [loadId],
    );
    expect(Number(rows[0].count)).toBe(1); // still a single row
    expect((await engagementRow(loadId))?.dwell_ms).toBe(9000);
  });

  it("filters out unknown/garbage event names", async () => {
    const loadId = randomUUID();
    const events: RawEvent[] = [
      { e: "arrive", t: 0, seq: 0 },
      { e: "visible", t: 0, seq: 1 },
      { e: "teleport", t: 500, seq: 2 }, // bogus, must be dropped
      { e: "hidden", t: 2000, seq: 3 },
    ];
    await recordEvents(ADDR, loadId, events, null);

    const rows = await pageEventRows(loadId);
    expect(rows.map((r) => r.event)).toEqual(["arrive", "visible", "hidden"]);
    expect((await engagementRow(loadId))?.dwell_ms).toBe(2000);
  });

  it("nulls an arrivedVia value outside the allowed set", async () => {
    const loadId = randomUUID();
    await recordEvents(
      ADDR,
      loadId,
      [
        { e: "arrive", t: 0, seq: 0, via: "sideways" },
        { e: "visible", t: 0, seq: 1 },
        { e: "hidden", t: 1000, seq: 2 },
      ],
      null,
    );
    expect((await engagementRow(loadId))?.arrived_via).toBeNull();
  });

  it("writes no engagement row when the computed dwell is negative", async () => {
    const loadId = randomUUID();
    await recordEvents(
      ADDR,
      loadId,
      [
        { e: "arrive", t: 0, seq: 0 },
        { e: "visible", t: 5000, seq: 1 },
        { e: "hidden", t: 1000, seq: 2 }, // t goes backwards -> negative span
      ],
      null,
    );
    expect(await pageEventRows(loadId)).toHaveLength(3); // raw events still land
    expect(await engagementRow(loadId)).toBeUndefined();
  });

  it("writes no engagement row when the computed dwell exceeds the 6h cap", async () => {
    const loadId = randomUUID();
    const sevenHoursMs = 7 * 60 * 60 * 1000;
    await recordEvents(
      ADDR,
      loadId,
      [
        { e: "arrive", t: 0, seq: 0 },
        { e: "visible", t: 0, seq: 1 },
        { e: "hidden", t: sevenHoursMs, seq: 2 },
      ],
      null,
    );
    expect(await engagementRow(loadId)).toBeUndefined();
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
