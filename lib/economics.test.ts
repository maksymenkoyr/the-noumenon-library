import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  // Small ceilings so both tiers are cheap to exhaust; the hourly tier is set
  // above the minute tier so a test can trip one without the other.
  process.env.RATE_LIMIT_PER_MINUTE = "3";
  process.env.RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.RATE_LIMIT_PER_HOUR = "5";
  process.env.RATE_LIMIT_HOUR_WINDOW_SECONDS = "3600";
});

import { checkAdmission, noteGeneration } from "./economics";
import { closePool, query } from "./db";
import { ipHash } from "./ipHash";

const IP = "203.0.113.42";
const HASH = ipHash(IP);

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE rate_limit_hits, monthly_spend CASCADE");
});

afterAll(async () => {
  await closePool();
});

describe("checkAdmission rate-limit tiers", () => {
  it("admits under both ceilings", async () => {
    for (let i = 0; i < 2; i++) {
      expect(await checkAdmission({ clientIp: IP })).toEqual({ ok: true });
      await noteGeneration({ clientIp: IP });
    }
  });

  it("trips the per-minute tier before the (looser) hourly one", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await checkAdmission({ clientIp: IP })).ok).toBe(true);
      await noteGeneration({ clientIp: IP });
    }
    // 4th: at the per-minute ceiling of 3, well under the hourly ceiling of 5.
    expect(await checkAdmission({ clientIp: IP })).toEqual({
      ok: false,
      reason: "rate_limit",
    });
  });

  it("trips the hourly tier even while a fresh minute window is clear", async () => {
    // Seed 5 hits an hour ago — outside the 60s minute window (so that check
    // alone would pass) but inside the 3600s hour window.
    await query(
      `INSERT INTO rate_limit_hits (ip_hash, created_at)
       SELECT $1, now() - interval '90 seconds'
       FROM generate_series(1, 5)`,
      [HASH],
    );
    const result = await checkAdmission({ clientIp: IP });
    expect(result).toEqual({ ok: false, reason: "rate_limit" });
  });
});

describe("noteGeneration retention", () => {
  it("keeps hits inside the hourly window when pruning (regression: must not prune at the minute window)", async () => {
    // Seed one hit 90s old — outside the 60s minute window, inside the hour
    // window. A prune keyed to the minute window would incorrectly delete it,
    // silently undercounting the hourly tier.
    await query(
      `INSERT INTO rate_limit_hits (ip_hash, created_at)
       VALUES ($1, now() - interval '90 seconds')`,
      [HASH],
    );
    await noteGeneration({ clientIp: IP }); // inserts a fresh hit + prunes
    const rows = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM rate_limit_hits WHERE ip_hash = $1",
      [HASH],
    );
    // The fresh hit plus the 90s-old one should both survive the prune.
    expect(rows[0].count).toBe(2);
  });

  it("prunes hits older than the hourly window", async () => {
    await query(
      `INSERT INTO rate_limit_hits (ip_hash, created_at)
       VALUES ($1, now() - interval '2 hours')`,
      [HASH],
    );
    await noteGeneration({ clientIp: IP });
    const rows = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM rate_limit_hits WHERE ip_hash = $1",
      [HASH],
    );
    // Only the fresh hit from noteGeneration survives; the 2h-old one is pruned.
    expect(rows[0].count).toBe(1);
  });
});
