import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

import { closePool, query } from "./db";
import {
  getArrivalSignals,
  getModelSignals,
  getPageSignals,
  getVariantSignals,
} from "./insights";
import { resolveReport } from "./reports";

// Two committed ('ok') pages with distinct provenance, plus one page still
// generating — page_signals (and everything rolled up from it) must exclude
// the latter entirely.
const ADDR1 = "test-ins/1/1/1/1";
const ADDR2 = "test-ins/2/1/1/1";
const NOT_OK = "test-ins/3/1/1/1";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query(
    "TRUNCATE pages, page_likes, page_dislikes, page_reports, engagement CASCADE",
  );

  await query(
    `INSERT INTO pages (address, status, model, prompt_variant) VALUES
       ($1, 'ok', 'model-a', 'variant-a'),
       ($2, 'ok', 'model-b', 'variant-b'),
       ($3, 'generating', 'model-c', 'variant-c')`,
    [ADDR1, ADDR2, NOT_OK],
  );

  await query("INSERT INTO page_likes (address, count) VALUES ($1, 5), ($2, 2)", [
    ADDR1,
    ADDR2,
  ]);
  await query("INSERT INTO page_dislikes (address, count) VALUES ($1, 1)", [ADDR1]);

  // ADDR1: one open report and one resolved report — page_signals must only
  // count the open one.
  await query("INSERT INTO page_reports (address) VALUES ($1)", [ADDR1]);
  const [resolved] = await query<{ id: string }>(
    "INSERT INTO page_reports (address) VALUES ($1) RETURNING id",
    [ADDR1],
  );
  await resolveReport(Number(resolved.id));

  // Dwell rows: ADDR1 gets three (median = the middle value, 2000), one of
  // them with a NULL arrived_via; ADDR2 gets one.
  await query(
    `INSERT INTO engagement (address, dwell_ms, arrived_via) VALUES
       ($1, 1000, 'random'),
       ($1, 2000, 'next'),
       ($1, 3000, NULL),
       ($2, 5000, 'typed')`,
    [ADDR1, ADDR2],
  );
});

afterAll(async () => {
  await closePool();
});

describe("getPageSignals", () => {
  it("rolls up likes, dislikes, open reports, visits, and median dwell per page", async () => {
    const rows = await getPageSignals();
    const byAddress = new Map(rows.map((r) => [r.address, r]));

    const p1 = byAddress.get(ADDR1)!;
    expect(p1.model).toBe("model-a");
    expect(p1.promptVariant).toBe("variant-a");
    expect(p1.likes).toBe(5);
    expect(p1.dislikes).toBe(1);
    expect(p1.openReports).toBe(1); // resolved one excluded
    expect(p1.visits).toBe(3);
    expect(p1.avgDwellMs).toBe(2000);
    expect(p1.medianDwellMs).toBe(2000);

    const p2 = byAddress.get(ADDR2)!;
    expect(p2.likes).toBe(2);
    expect(p2.dislikes).toBe(0);
    expect(p2.openReports).toBe(0);
    expect(p2.visits).toBe(1);
    expect(p2.avgDwellMs).toBe(5000);
    expect(p2.medianDwellMs).toBe(5000);
  });

  it("excludes a page that hasn't committed ('ok')", async () => {
    const rows = await getPageSignals();
    expect(rows.some((r) => r.address === NOT_OK)).toBe(false);
  });

  it("orders by visits desc then address, and respects the limit", async () => {
    const rows = await getPageSignals(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe(ADDR1); // 3 visits > ADDR2's 1
  });
});

describe("getModelSignals", () => {
  it("groups by model, excluding the non-ok page's model", async () => {
    const rows = await getModelSignals();
    const models = rows.map((r) => r.model).sort();
    expect(models).toEqual(["model-a", "model-b"]);

    const a = rows.find((r) => r.model === "model-a")!;
    expect(a.pages).toBe(1);
    expect(a.likes).toBe(5);
    expect(a.dislikes).toBe(1);
    expect(a.openReports).toBe(1);
    expect(a.visits).toBe(3);
    expect(a.avgMedianDwellMs).toBe(2000);
  });
});

describe("getVariantSignals", () => {
  it("groups by prompt_variant, excluding the non-ok page's variant", async () => {
    const rows = await getVariantSignals();
    const variants = rows.map((r) => r.promptVariant).sort();
    expect(variants).toEqual(["variant-a", "variant-b"]);

    const b = rows.find((r) => r.promptVariant === "variant-b")!;
    expect(b.pages).toBe(1);
    expect(b.likes).toBe(2);
    expect(b.visits).toBe(1);
    expect(b.avgMedianDwellMs).toBe(5000);
  });
});

describe("getArrivalSignals", () => {
  it("groups by arrived_via, including the NULL group", async () => {
    const rows = await getArrivalSignals();
    const byVia = new Map(rows.map((r) => [r.arrivedVia, r]));

    expect(byVia.get("random")?.visits).toBe(1);
    expect(byVia.get("next")?.visits).toBe(1);
    expect(byVia.get("typed")?.visits).toBe(1);

    const nullGroup = byVia.get(null);
    expect(nullGroup?.visits).toBe(1);
    expect(nullGroup?.avgDwellMs).toBe(3000);
    expect(nullGroup?.medianDwellMs).toBe(3000);
  });
});
