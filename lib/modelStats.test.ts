import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, query } from "./db";
import {
  FREE_TIER_KEY,
  freeTierOnCooldown,
  getModelStats,
  markRateLimited,
  modelOnCooldown,
  recordModelCall,
} from "./modelStats";

process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE model_stats");
});

afterAll(async () => {
  await closePool();
});

describe("modelStats", () => {
  it("computes average duration from accumulated calls", async () => {
    await recordModelCall("model-a:free", { ms: 100, ok: true });
    await recordModelCall("model-a:free", { ms: 300, ok: true });

    const stats = await getModelStats();
    expect(stats.get("model-a:free")?.avgMs).toBe(200);
  });

  it("counts errors separately from successful calls, without skewing avgMs", async () => {
    await recordModelCall("model-b:free", { ms: 100, ok: true });
    // A failed attempt's duration is not folded into total_ms — an error
    // that takes 9999ms to surface shouldn't make the model look slow.
    await recordModelCall("model-b:free", { ms: 9999, ok: false });

    const stats = await getModelStats();
    expect(stats.get("model-b:free")?.avgMs).toBe(100);
  });

  it("reports no stats for a model with no calls yet", async () => {
    const stats = await getModelStats();
    expect(stats.get("model-never-called:free")).toBeUndefined();
  });

  it("marks and reports a per-model rate-limit cooldown", async () => {
    await markRateLimited("model-c:free", 60);
    const stats = await getModelStats();
    expect(modelOnCooldown(stats, "model-c:free")).toBe(true);
    expect(modelOnCooldown(stats, "model-d:free")).toBe(false); // never limited
  });

  it("tracks the account-wide free-cap cooldown under its own sentinel key", async () => {
    await markRateLimited(FREE_TIER_KEY, 60);
    const stats = await getModelStats();
    expect(freeTierOnCooldown(stats)).toBe(true);
    // A per-model cooldown check on an unrelated model isn't affected.
    expect(modelOnCooldown(stats, "model-c:free")).toBe(false);
  });

  it("does not report a cooldown that has already expired", async () => {
    await markRateLimited("model-e:free", -1); // already in the past
    const stats = await getModelStats();
    expect(modelOnCooldown(stats, "model-e:free")).toBe(false);
  });
});
