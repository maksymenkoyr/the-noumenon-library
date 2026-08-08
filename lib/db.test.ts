import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// config.databaseUrl is read eagerly when the pool is first built, and
// lib/config.ts evaluates at import time — set the env before ./db is imported.
// Same vi.hoisted pattern as registry.test.ts.
vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

// Mock monitoring so we can assert the payload rather than the side effect,
// same pattern as reportEmail.test.ts.
vi.mock("./monitor", () => ({ monitor: vi.fn() }));

import { closePool, query } from "./db";
import { monitor } from "./monitor";

const monitorMock = vi.mocked(monitor);

/** A statement guaranteed to throw on any reachable Postgres. */
const FAILING_SQL = "SELECT 1 FROM a_table_that_does_not_exist";

afterAll(async () => {
  await closePool();
});

describe("query", () => {
  beforeEach(() => {
    monitorMock.mockReset();
  });

  it("does not fire db_query_failed when the query succeeds", async () => {
    const rows = await query<{ one: number }>("SELECT 1 AS one", [], "test.ok");
    expect(rows[0].one).toBe(1);
    expect(monitorMock).not.toHaveBeenCalled();
  });

  it("tags db_query_failed with the caller's op and re-throws", async () => {
    await expect(query(FAILING_SQL, [], "store.commitPage")).rejects.toThrow();

    expect(monitorMock).toHaveBeenCalledTimes(1);
    const [event, fields] = monitorMock.mock.calls[0];
    expect(event).toBe("db_query_failed");
    expect(fields).toMatchObject({ op: "store.commitPage" });
    // The driver message is passed through so the alert is actionable.
    expect(typeof (fields as { error: unknown }).error).toBe("string");
  });

  it("reports op as 'unknown' when the caller does not label the query", async () => {
    await expect(query(FAILING_SQL)).rejects.toThrow();

    expect(monitorMock).toHaveBeenCalledTimes(1);
    expect(monitorMock.mock.calls[0][1]).toMatchObject({ op: "unknown" });
  });

  it("distinguishes two failing call sites by op alone", async () => {
    await expect(
      query(FAILING_SQL, [], "modelStats.recordModelCall"),
    ).rejects.toThrow();
    await expect(query(FAILING_SQL, [], "store.getPage")).rejects.toThrow();

    const ops = monitorMock.mock.calls.map(
      ([, fields]) => (fields as { op: string }).op,
    );
    expect(ops).toEqual(["modelStats.recordModelCall", "store.getPage"]);
  });
});
