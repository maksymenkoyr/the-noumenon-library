import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

// Mock only the LLM call; keep chooseLevers real so provenance is genuine.
vi.mock("./generate", async () => {
  const actual = await vi.importActual<typeof import("./generate")>("./generate");
  return { ...actual, generatePage: vi.fn() };
});
// Mock moderation so the pipeline never hits the network; default = pass.
vi.mock("./moderate", () => ({
  moderate: vi.fn(async () => ({ ok: true })),
}));
// Mock monitoring so we can assert which structured events the pipeline emits
// without writing JSON to the test output.
vi.mock("./monitor", () => ({ monitor: vi.fn() }));

import { closePool, query } from "./db";
import { generatePage } from "./generate";
import { moderate } from "./moderate";
import { monitor } from "./monitor";
import { generatePipeline } from "./pipeline";
import { hashContent } from "./store";

const generateMock = vi.mocked(generatePage);
const moderateMock = vi.mocked(moderate);
const monitorMock = vi.mocked(monitor);
const ADDR = "pipe/1/1/1/1";

/** generatePage now returns text + usage; 100 tokens per call for accounting. */
const gen = (text: string) => ({ text, usage: { tokens: 100, costUsd: 0 } });

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE pages");
  generateMock.mockReset();
  moderateMock.mockReset();
  monitorMock.mockReset();
  moderateMock.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  await closePool();
});

async function seedExistingPage(address: string, content: string) {
  await query(
    `INSERT INTO pages (address, status, content, content_hash, committed_at)
     VALUES ($1, 'ok', $2, $3, now())`,
    [address, content, hashContent(content)],
  );
}

describe("generatePipeline", () => {
  it("returns ok content with fully-populated provenance", async () => {
    generateMock.mockResolvedValue(gen("a unique page"));
    const result = await generatePipeline(ADDR);

    expect(result.content).toBe("a unique page");
    expect(result.provenance.model).toBeTruthy();
    expect(result.provenance.temperature).toBeGreaterThan(0);
    expect(result.provenance.prompt_variant).toBe("base-v2");
    // The form/register lever is logged (in the seed_word column).
    expect(result.provenance.seed_word).toBeTruthy();
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("regenerates once when moderation fails, then passes", async () => {
    generateMock
      .mockResolvedValueOnce(gen("flagged content"))
      .mockResolvedValueOnce(gen("clean content"));
    moderateMock
      .mockResolvedValueOnce({ ok: false }) // first attempt fails
      .mockResolvedValueOnce({ ok: true }); // regenerated attempt passes

    const result = await generatePipeline(ADDR);

    expect(result.content).toBe("clean content");
    expect(generateMock).toHaveBeenCalledTimes(2);
    // Usage is summed across every generation call (both attempts here).
    expect(result.usage.tokens).toBe(200);
    // A single reject that recovers on regen is normal — no monitor event.
    expect(monitorMock).not.toHaveBeenCalled();
  });

  it("throws and flags a persistent reject (no dark-shelf) when moderation fails twice", async () => {
    generateMock.mockResolvedValue(gen("flagged content"));
    moderateMock.mockResolvedValue({ ok: false });

    await expect(generatePipeline(ADDR)).rejects.toThrow(/moderation rejected/i);
    expect(generateMock).toHaveBeenCalledTimes(2);
    // Exactly one structured event so 2-reject cases are countable downstream.
    expect(monitorMock).toHaveBeenCalledTimes(1);
    expect(monitorMock).toHaveBeenCalledWith("moderation_persistent_reject", {
      address: ADDR,
      rejects: 2,
    });
  });

  it("regenerates once (fresh sample) on an exact-hash collision", async () => {
    await seedExistingPage("other/1/1/1/1", "duplicated content");
    generateMock
      .mockResolvedValueOnce(gen("duplicated content")) // collides
      .mockResolvedValueOnce(gen("a different page")); // fresh sample

    const result = await generatePipeline(ADDR);

    expect(result.content).toBe("a different page");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the original page if the dedup regen also fails moderation", async () => {
    await seedExistingPage("other/1/1/1/1", "duplicated content");
    generateMock
      .mockResolvedValueOnce(gen("duplicated content")) // passes moderation, collides
      .mockResolvedValueOnce(gen("a different page")); // dedup regen, fails moderation
    moderateMock
      .mockResolvedValueOnce({ ok: true }) // original passes
      .mockResolvedValueOnce({ ok: false }); // dedup regen fails

    const result = await generatePipeline(ADDR);

    // Falls back to the already-passed original (near-duplicates are allowed).
    expect(result.content).toBe("duplicated content");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("does not regenerate when content is unique and passes", async () => {
    await seedExistingPage("other/1/1/1/1", "something else entirely");
    generateMock.mockResolvedValue(gen("a unique page"));

    await generatePipeline(ADDR);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});
