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
  // $1 cap makes the 50/80/100% thresholds (below) land on clean dollar
  // amounts: $0.50, $0.80, $1.00.
  process.env.MONTHLY_SPEND_CAP_USD = "1";
});

import { checkAdmission, noteGeneration, recordSpend } from "./economics";
import { closePool, query } from "./db";
import { closeMonitorPool } from "./monitor";
import { ipHash } from "./ipHash";

const IP = "203.0.113.42";
const HASH = ipHash(IP);

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE rate_limit_hits, monthly_spend, monitor_events CASCADE");
});

afterAll(async () => {
  await closePool();
  await closeMonitorPool();
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

/**
 * Regression coverage for the launch-blocker fix (§1.4, docs/…): the spend
 * cap and rate-limit trips used to only call devLog, a no-op in production
 * (lib/log.ts gates on config.devMode) — so an operator would never learn the
 * cap had tripped beyond every visitor seeing the explore-only placeholder.
 * These assert the durable side effect (a monitor_events row), not the
 * Telegram push, which lib/monitor.test.ts already covers in isolation.
 */
describe("monitor integration", () => {
  async function monitorEventCount(event: string): Promise<number> {
    const rows = await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM monitor_events WHERE event = $1",
      [event],
    );
    return rows[0].count;
  }

  it("reports spend_cap_reached once the monthly cap is hit", async () => {
    await query(
      "INSERT INTO monthly_spend (month, tokens, cost_usd) VALUES (to_char(now(), 'YYYY-MM'), 1000, 1)",
    );
    expect(await checkAdmission({ clientIp: IP })).toEqual({
      ok: false,
      reason: "spend_cap",
    });
    expect(await monitorEventCount("spend_cap_reached")).toBe(1);
  });

  it("reports rate_limit_tripped when a tier trips", async () => {
    for (let i = 0; i < 3; i++) {
      await checkAdmission({ clientIp: IP });
      await noteGeneration({ clientIp: IP });
    }
    await checkAdmission({ clientIp: IP }); // 4th: trips the per-minute tier
    expect(await monitorEventCount("rate_limit_tripped")).toBe(1);
  });

  it("fires spend_threshold_reached exactly once per threshold as spend crosses 50/80/100%", async () => {
    await recordSpend({ tokens: 100, costUsd: 0.5 }); // → $0.50 = 50%
    await recordSpend({ tokens: 100, costUsd: 0.31 }); // → $0.81 = 81%
    await recordSpend({ tokens: 100, costUsd: 0.2 }); // → $1.01 = 101%, over cap
    // A further generation past the cap must not re-fire the 100% alert.
    await recordSpend({ tokens: 100, costUsd: 0.05 });

    const rows = await query<{ fields: { pct: number } }>(
      "SELECT fields FROM monitor_events WHERE event = 'spend_threshold_reached' ORDER BY id",
    );
    expect(rows.map((r) => r.fields.pct)).toEqual([50, 80, 100]);
  });

  it("does not alert below the first threshold", async () => {
    await recordSpend({ tokens: 100, costUsd: 0.49 }); // → $0.49 = 49%, just under 50%
    expect(await monitorEventCount("spend_threshold_reached")).toBe(0);
  });
});
