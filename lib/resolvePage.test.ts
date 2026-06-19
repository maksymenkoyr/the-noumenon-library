import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  process.env.STALE_RESERVATION_SECONDS = "2";
  process.env.GENERATION_WAIT_SECONDS = "5";
  process.env.WAIT_POLL_INTERVAL_MS = "50";
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
    };
  }),
}));

import { closePool, query } from "./db";
import { generatePipeline } from "./pipeline";
import { resolvePage } from "./resolvePage";
import { getPage, reservePage } from "./store";

const generateMock = vi.mocked(generatePipeline);

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE pages");
  generateMock.mockClear();
});

afterAll(async () => {
  await closePool();
});

describe("resolvePage lifecycle", () => {
  it("generates and commits on first visit", async () => {
    const page = await resolvePage("a/1/1/1/1");
    expect(page).toEqual({ status: "ok", text: "page for a/1/1/1/1" });
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
    expect(second).toEqual(first);
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
