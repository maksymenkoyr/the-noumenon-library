import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

import { closePool, query } from "./db";
import { listOpenReports, recordReport, resolveReport } from "./reports";

const ADDR = "test-rep/1/1/1/1";
const OTHER = "test-rep/2/1/1/1";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE pages, page_reports CASCADE");
  // Reports FK to pages(address); the report control only renders on a
  // committed page, so give the tests real page rows.
  await query("INSERT INTO pages (address, status) VALUES ($1, 'ok'), ($2, 'ok')", [
    ADDR,
    OTHER,
  ]);
});

afterAll(async () => {
  await closePool();
});

describe("recordReport", () => {
  it("stores an open report with a trimmed reason", async () => {
    await recordReport(ADDR, "  looks like lorem ipsum  ");
    const [report] = await listOpenReports();
    expect(report.address).toBe(ADDR);
    expect(report.reason).toBe("looks like lorem ipsum");
    expect(report.status).toBe("open");
    expect(report.resolvedAt).toBeNull();
  });

  it("nulls an empty or whitespace reason", async () => {
    await recordReport(ADDR, "   ");
    await recordReport(ADDR);
    const reports = await listOpenReports();
    expect(reports.map((r) => r.reason)).toEqual([null, null]);
  });

  it("truncates an oversized reason to 500 chars", async () => {
    await recordReport(ADDR, "x".repeat(2000));
    expect((await listOpenReports())[0].reason).toHaveLength(500);
  });

  it("flags only the first open report per address", async () => {
    expect((await recordReport(ADDR)).firstOpenForAddress).toBe(true);
    expect((await recordReport(ADDR)).firstOpenForAddress).toBe(false);
    // Another address is its own queue…
    expect((await recordReport(OTHER)).firstOpenForAddress).toBe(true);
  });

  it("flags again once the queue for the address is cleared", async () => {
    const first = await recordReport(ADDR);
    const second = await recordReport(ADDR);
    await resolveReport(first.id);
    await resolveReport(second.id);
    expect((await recordReport(ADDR)).firstOpenForAddress).toBe(true);
  });

  it("rejects an address that was never committed (pages FK)", async () => {
    await expect(recordReport("nowhere/1/1/1/1")).rejects.toThrow();
  });
});

describe("listOpenReports", () => {
  it("lists oldest first and excludes resolved", async () => {
    const first = await recordReport(ADDR, "first");
    await recordReport(OTHER, "second");
    await resolveReport(first.id);
    const reports = await listOpenReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].reason).toBe("second");
  });
});

describe("resolveReport", () => {
  it("resolves an open report and stamps resolved_at", async () => {
    const { id } = await recordReport(ADDR);
    expect(await resolveReport(id)).toBe(true);
    const rows = await query<{ status: string; resolved_at: Date | null }>(
      "SELECT status, resolved_at FROM page_reports WHERE id = $1",
      [id],
    );
    expect(rows[0].status).toBe("resolved");
    expect(rows[0].resolved_at).not.toBeNull();
  });

  it("is a no-op on an already-resolved or unknown id", async () => {
    const { id } = await recordReport(ADDR);
    await resolveReport(id);
    expect(await resolveReport(id)).toBe(false);
    expect(await resolveReport(999999)).toBe(false);
  });
});
