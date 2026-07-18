import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  process.env.STALE_RESERVATION_SECONDS = "2";
  process.env.GENERATION_WAIT_SECONDS = "5";
  process.env.WAIT_POLL_INTERVAL_MS = "50";
  // A small rate limit so the admission tests can cross it cheaply. Spend cap
  // stays at its default (10) — those tests seed the counter directly.
  process.env.RATE_LIMIT_PER_MINUTE = "3";
});

// Mock the generation pipeline (LLM + moderation + dedup); resolvePage owns
// only the concurrency/store lifecycle and placeholder rendering exercised here.
vi.mock("./pipeline", () => ({
  generatePipeline: vi.fn(async (address: string) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      content: `page for ${address}`,
      provenance: {
        model: "test-model",
        temperature: 0.9,
        prompt_variant: "base-v1",
      },
      usage: { tokens: 100, costUsd: 0 },
    };
  }),
}));

import { closePool, query } from "./db";
import { generatePipeline } from "./pipeline";
import { resolvePage } from "./resolvePage";
import { getPage, reservePage, takeDownPage } from "./store";

const generateMock = vi.mocked(generatePipeline);

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE pages, rate_limit_hits, monthly_spend CASCADE");
  generateMock.mockClear();
});

/** The current UTC month key, matching lib/economics.ts currentMonth(). */
const currentMonth = new Date().toISOString().slice(0, 7);

afterAll(async () => {
  await closePool();
});

describe("resolvePage lifecycle", () => {
  it("generates and commits on first visit", async () => {
    const page = await resolvePage("a/1/1/1/1");
    expect(page).toMatchObject({ status: "ok", text: "page for a/1/1/1/1" });
    // Fresh generation carries dev-overlay provenance: the model and a live
    // duration measurement (lib/devMode).
    expect(page.model).toBe("test-model");
    expect(typeof page.durationMs).toBe("number");
    expect(generateMock).toHaveBeenCalledTimes(1);
    const row = await getPage("a/1/1/1/1");
    expect(row?.status).toBe("ok");
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.model).toBeTruthy();
    expect(row?.temperature).toBe(0.9);
    expect(row?.prompt_variant).toBe("base-v1");
    expect(row?.seed_word).toBeNull();
  });

  it("revisits return the identical stored page with no LLM call", async () => {
    const first = await resolvePage("b/1/1/1/1");
    const second = await resolvePage("b/1/1/1/1");
    // The stored page is identical (status/text/model); only the live-measured
    // durationMs differs — present on the fresh generation, absent on revisit.
    expect(second).toMatchObject({
      status: first.status,
      text: first.text,
      model: first.model,
    });
    expect(second.durationMs).toBeUndefined();
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent first-visitors into exactly one generation", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => resolvePage("c/1/1/1/1")),
    );
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
    expect(results[0].text).toBe("page for c/1/1/1/1");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation on generation failure, then recovers", async () => {
    generateMock.mockRejectedValueOnce(new Error("provider down"));
    await expect(resolvePage("d/1/1/1/1")).rejects.toThrow("provider down");
    expect(await getPage("d/1/1/1/1")).toBeNull();

    const page = await resolvePage("d/1/1/1/1");
    expect(page.text).toBe("page for d/1/1/1/1");
    expect((await getPage("d/1/1/1/1"))?.status).toBe("ok");
  });

  it("leaves no row when the pipeline throws on a persistent moderation reject", async () => {
    // The pipeline throws (rather than dark-shelving) after two rejects; the
    // reservation is released so a later visit simply retries — no placeholder.
    generateMock.mockRejectedValueOnce(new Error("Moderation rejected g/1/1/1/1 twice"));
    await expect(resolvePage("g/1/1/1/1")).rejects.toThrow(/moderation rejected/i);
    expect(await getPage("g/1/1/1/1")).toBeNull();
  });

  it("reclaims a stale reservation from a crashed generation", async () => {
    await reservePage("e/1/1/1/1");
    await query(
      "UPDATE pages SET created_at = now() - interval '10 seconds' WHERE address = $1",
      ["e/1/1/1/1"],
    );
    const page = await resolvePage("e/1/1/1/1");
    expect(page.text).toBe("page for e/1/1/1/1");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("lets a takedown that lands mid-generation win over the commit", async () => {
    // The takedown arrives while the pipeline is running; the commit must not
    // resurrect the page to 'ok' (docs/reference/legal.md "never regenerates").
    generateMock.mockImplementationOnce(async (address: string) => {
      await takeDownPage(address);
      return {
        content: `page for ${address}`,
        provenance: { model: "test-model", temperature: 0.9, prompt_variant: "base-v1" },
        usage: { tokens: 100, costUsd: 0 },
      };
    });
    const page = await resolvePage("f/1/1/1/1");
    expect(page.status).toBe("taken_down");
    const row = await getPage("f/1/1/1/1");
    expect(row?.status).toBe("taken_down");
    expect(row?.content).toBeNull();
    // The LLM call still happened, so its spend is recorded regardless.
    const rows = await query<{ tokens: string }>(
      "SELECT tokens FROM monthly_spend WHERE month = $1",
      [currentMonth],
    );
    expect(Number(rows[0]?.tokens)).toBe(100);
  });

  it("returns the taken-down placeholder for a taken_down page", async () => {
    await query(
      "INSERT INTO pages (address, status, committed_at) VALUES ($1, 'taken_down', now())",
      ["h/1/1/1/1"],
    );
    const page = await resolvePage("h/1/1/1/1");
    expect(page.status).toBe("taken_down");
    expect(page.text).toMatch(/removed from the library/i);
    expect(generateMock).not.toHaveBeenCalled();
  });
});

describe("resolvePage admission control (§10)", () => {
  it("records spend after a successful generation", async () => {
    await resolvePage("a/1/1/1/1");
    const rows = await query<{ tokens: string; cost_usd: string }>(
      "SELECT tokens, cost_usd FROM monthly_spend WHERE month = $1",
      [currentMonth],
    );
    expect(Number(rows[0]?.tokens)).toBe(100);
  });

  it("flips to explore-only past the monthly spend cap, without crystallizing", async () => {
    // Seed the counter at the default cap (10) so the next generation is refused.
    await query(
      "INSERT INTO monthly_spend (month, tokens, cost_usd) VALUES ($1, 0, 10)",
      [currentMonth],
    );
    const page = await resolvePage("b/1/1/1/1");
    expect(page.status).toBe("explore");
    expect(page.text).toMatch(/still dark/i);
    expect(generateMock).not.toHaveBeenCalled();
    // Not crystallized: a later visit (after reset) can still generate it.
    expect(await getPage("b/1/1/1/1")).toBeNull();
  });

  it("rate-limits a visitor past the per-window generation limit", async () => {
    const ctx = { clientIp: "203.0.113.7" };
    // Limit is 3 (hoisted). First three distinct addresses generate…
    for (const addr of ["c/1/1/1/1", "c/1/1/1/2", "c/1/1/1/3"]) {
      expect((await resolvePage(addr, ctx)).status).toBe("ok");
    }
    // …the fourth is refused and leaves no row.
    const fourth = await resolvePage("c/1/1/1/4", ctx);
    expect(fourth.status).toBe("explore");
    expect(await getPage("c/1/1/1/4")).toBeNull();
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("does not rate-limit when no client IP is supplied", async () => {
    for (const addr of ["d/1/1/1/1", "d/1/1/1/2", "d/1/1/1/3", "d/1/1/1/4"]) {
      expect((await resolvePage(addr)).status).toBe("ok");
    }
    expect(generateMock).toHaveBeenCalledTimes(4);
  });
});
