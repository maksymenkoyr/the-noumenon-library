import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  // chooseLevers() stays real (below), so it needs a real, eligible
  // model_registry row to pick from (lib/registry.ts) — seeded in beforeAll.
  process.env.OPENROUTER_API_KEY = "test-key";
});

// Mock only the LLM call; keep chooseLevers real so provenance is genuine.
vi.mock("./generate", async () => {
  const actual = await vi.importActual<typeof import("./generate")>("./generate");
  return { ...actual, generatePage: vi.fn() };
});
// Mock moderation so the pipeline never hits the network; default = pass.
vi.mock("./moderate", () => ({
  moderate: vi.fn(async () => ({ ok: true, ms: 50 })),
}));
// Mock monitoring so we can assert which structured events the pipeline emits
// without writing JSON to the test output.
vi.mock("./monitor", () => ({ monitor: vi.fn() }));

import type { BookContext } from "./book";
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

/**
 * generatePage now returns text + model + provider + usage; 100 tokens per
 * call for accounting. `model` defaults to a fixed id since these tests mock
 * generatePage directly — the real fallback behavior is covered in
 * generate.test.ts.
 */
const gen = (text: string, model = "mock-model") => ({
  text,
  model,
  provider: "openrouter" as const,
  usage: { tokens: 100, costUsd: 0 },
  prompt: `prompt for: ${text}`,
  durationMs: 500,
});

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  // chooseLevers() is real in this suite — one eligible generation row is
  // all it needs (its own selection logic is covered in registry.test.ts /
  // generate.test.ts).
  // ON CONFLICT DO NOTHING: several test files seed this same row into the
  // shared test database (fileParallelism: false runs them sequentially, not
  // isolated), so this must be idempotent regardless of run order.
  await query(
    `INSERT INTO model_registry (slug, provider, task, enabled, weight, temperature, max_tokens)
     VALUES ('mock-model', 'openrouter', 'generation', true, 10, 0.9, 1000)
     ON CONFLICT (slug, task) DO NOTHING`,
  );
});

beforeEach(async () => {
  await query("TRUNCATE pages CASCADE");
  generateMock.mockReset();
  moderateMock.mockReset();
  monitorMock.mockReset();
  moderateMock.mockResolvedValue({ ok: true, ms: 50 });
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
    // The exact prompt that produced the committed content (dev-overlay
    // provenance, lib/resolvePage.ts / lib/devMode).
    expect(result.prompt).toBe("prompt for: a unique page");
    // Generation and moderation time are reported separately, not as one total.
    expect(result.generationMs).toBe(500);
    expect(result.moderationMs).toBe(50);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("regenerates once when moderation fails, then passes", async () => {
    generateMock
      .mockResolvedValueOnce(gen("flagged content"))
      .mockResolvedValueOnce(gen("clean content"));
    moderateMock
      .mockResolvedValueOnce({ ok: false, ms: 40 }) // first attempt fails
      .mockResolvedValueOnce({ ok: true, ms: 60 }); // regenerated attempt passes

    const result = await generatePipeline(ADDR);

    expect(result.content).toBe("clean content");
    expect(generateMock).toHaveBeenCalledTimes(2);
    // Usage is summed across every generation call (both attempts here).
    expect(result.usage.tokens).toBe(200);
    // The prompt tracks the committed (regenerated) attempt, not the rejected one.
    expect(result.prompt).toBe("prompt for: clean content");
    // Both timings sum across every attempt, including the moderation reject.
    expect(result.generationMs).toBe(1000);
    expect(result.moderationMs).toBe(100);
    // A single reject that recovers on regen is normal — no monitor event.
    expect(monitorMock).not.toHaveBeenCalled();
  });

  it("throws and flags a persistent reject (no dark-shelf) when moderation fails twice", async () => {
    generateMock.mockResolvedValue(gen("flagged content"));
    moderateMock.mockResolvedValue({ ok: false, ms: 40 });

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
    expect(result.prompt).toBe("prompt for: a different page");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the original page if the dedup regen also fails moderation", async () => {
    await seedExistingPage("other/1/1/1/1", "duplicated content");
    generateMock
      .mockResolvedValueOnce(gen("duplicated content")) // passes moderation, collides
      .mockResolvedValueOnce(gen("a different page")); // dedup regen, fails moderation
    moderateMock
      .mockResolvedValueOnce({ ok: true, ms: 50 }) // original passes
      .mockResolvedValueOnce({ ok: false, ms: 45 }); // dedup regen fails

    const result = await generatePipeline(ADDR);

    // Falls back to the already-passed original (near-duplicates are allowed).
    expect(result.content).toBe("duplicated content");
    // The prompt matches the kept original, not the discarded dedup regen.
    expect(result.prompt).toBe("prompt for: duplicated content");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("does not regenerate when content is unique and passes", async () => {
    await seedExistingPage("other/1/1/1/1", "something else entirely");
    generateMock.mockResolvedValue(gen("a unique page"));

    await generatePipeline(ADDR);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("records the model that actually answered, even if generatePage fell back", async () => {
    // generatePage() (lib/generate.ts) can fall back to a different pool
    // model on a retryable error; its result.model may differ from the
    // model chooseLevers() requested. Provenance must reflect the former.
    generateMock.mockResolvedValue(gen("a unique page", "fallback-model:free"));

    const result = await generatePipeline(ADDR);

    expect(result.provenance.model).toBe("fallback-model:free");
  });
});

describe("generatePipeline with a book context (books experiment)", () => {
  const bookCtx: BookContext = {
    volumeKey: "pipe/1/1/1",
    book: {
      volume_key: "pipe/1/1/1",
      form: "a prayer",
      title: null,
      tags: null,
      model: null,
      prompt_variant: null,
      created_at: new Date(),
      titled_at: null,
    },
    prev: "The ship left harbor.\n…\nNo one watched it go.",
    next: "By morning the coast was gone.\n…\nThe log ends here.",
  };

  it("pins the locked form, book variant, and neighbor seams as levers", async () => {
    generateMock.mockResolvedValue(gen("a book page"));
    const result = await generatePipeline(ADDR, bookCtx);

    expect(result.provenance.prompt_variant).toBe("book-v1");
    expect(result.provenance.seed_word).toBe("a prayer");
    const levers = generateMock.mock.calls[0][0];
    expect(levers.form).toBe("a prayer");
    expect(levers.prev).toBe(bookCtx.prev);
    expect(levers.next).toBe(bookCtx.next);
  });

  it("keeps the locked form and seams across moderation and dedup regens", async () => {
    await seedExistingPage("other/1/1/1/1", "colliding content");
    generateMock
      .mockResolvedValueOnce(gen("flagged content")) // moderation reject
      .mockResolvedValueOnce(gen("colliding content")) // passes, then collides
      .mockResolvedValueOnce(gen("a fresh book page")); // dedup regen
    moderateMock
      .mockResolvedValueOnce({ ok: false, ms: 40 })
      .mockResolvedValue({ ok: true, ms: 50 });

    const result = await generatePipeline(ADDR, bookCtx);

    expect(result.content).toBe("a fresh book page");
    expect(result.provenance.prompt_variant).toBe("book-v1");
    expect(result.provenance.seed_word).toBe("a prayer");
    // Every attempt — initial, moderation regen, dedup regen — stayed in-book.
    for (const [levers] of generateMock.mock.calls) {
      expect(levers.form).toBe("a prayer");
      expect(levers.promptVariant).toBe("book-v1");
      expect(levers.prev).toBe(bookCtx.prev);
      expect(levers.next).toBe(bookCtx.next);
    }
  });

  it("without a book context, levers stay base-v2 with no seams", async () => {
    generateMock.mockResolvedValue(gen("a plain page"));
    const result = await generatePipeline(ADDR);

    expect(result.provenance.prompt_variant).toBe("base-v2");
    const levers = generateMock.mock.calls[0][0];
    expect(levers.prev).toBeUndefined();
    expect(levers.next).toBeUndefined();
  });
});
