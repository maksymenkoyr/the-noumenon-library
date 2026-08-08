import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  process.env.OPENROUTER_API_KEY = "test-key";
});

const createMock = vi.fn();
vi.mock("./providers", async () => {
  const actual = await vi.importActual<typeof import("./providers")>("./providers");
  return { ...actual, getClient: () => ({ chat: { completions: { create: createMock } } }) };
});

// chooseLevers asks the gallery for its association terms. Stub the network
// call and control the term list, so the seed lever can be asserted here
// without a provider (its own behavior lives in lib/gallerySeeds.test.ts).
const SEED_TERMS = ["bavaria", "roundel", "welding", "sediment", "oak bark"];
vi.mock("./gallerySeeds", async () => {
  const actual =
    await vi.importActual<typeof import("./gallerySeeds")>("./gallerySeeds");
  return { ...actual, termsForGallery: vi.fn(async () => SEED_TERMS) };
});

import { config } from "./config";
import { closePool, query } from "./db";
import {
  chooseLevers,
  generatePage,
  provenanceVariant,
  type GenerationLevers,
} from "./generate";
import { FREE_TIER_KEY } from "./modelStats";
import { buildPrompt, GENERATION_CONSTRAINTS } from "./prompts";

/** A minimal fake OpenAI chat completion. */
function completion(content: string, totalTokens = 0) {
  return { choices: [{ message: { content } }], usage: { total_tokens: totalTokens } };
}

const levers: GenerationLevers = {
  model: "model-a",
  provider: "openrouter",
  temperature: 0.9,
  maxTokens: 1000,
  pageWords: 200,
  start: "mid-sentence",
  startPhrase: "mid-sentence",
  ending: "cut-hard",
  promptVariant: "base-v3",
  constraints: [],
};

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  createMock.mockReset();
  await query("TRUNCATE model_registry, model_stats");
  // A small, known 2-model pool so fallback order is deterministic to assert
  // on (docs/reference/architecture.md §6, model-pool rework).
  await query(
    `INSERT INTO model_registry (slug, provider, task, enabled, weight, temperature, max_tokens)
     VALUES
       ('model-a', 'openrouter', 'generation', true, 10, 0.9, 1000),
       ('model-b', 'openrouter', 'generation', true, 10, 0.9, 1000)`,
  );
});

afterAll(async () => {
  await closePool();
});

describe("generatePage fallback", () => {
  it("falls back to the next pool model on a retryable error (429)", async () => {
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(429, undefined, "rate limited", undefined))
      .mockResolvedValueOnce(completion("fallback text", 42));

    const result = await generatePage(levers);

    expect(result.text).toBe("fallback text");
    expect(result.model).toBe("model-b");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0]).toMatchObject({ model: "model-a" });
    expect(createMock.mock.calls[1][0]).toMatchObject({ model: "model-b" });
  });

  it("falls back on a 5xx and on a connection error, not just 429", async () => {
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(503, undefined, "unavailable", undefined))
      .mockResolvedValueOnce(completion("recovered", 10));
    const result = await generatePage(levers);
    expect(result.model).toBe("model-b");

    createMock.mockReset();
    createMock
      .mockRejectedValueOnce(new OpenAI.APIConnectionError({ message: "ECONNRESET" }))
      .mockResolvedValueOnce(completion("recovered again", 10));
    const result2 = await generatePage(levers);
    expect(result2.model).toBe("model-b");
  });

  it("falls back on a 404 (delisted model) and marks it permanently unavailable", async () => {
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(404, undefined, "not found", undefined))
      .mockResolvedValueOnce(completion("fallback", 5));

    const result = await generatePage(levers);
    expect(result.model).toBe("model-b");

    const rows = await query<{ health: string }>(
      "SELECT health FROM model_registry WHERE slug = 'model-a' AND task = 'generation'",
    );
    expect(rows[0]?.health).toBe("unavailable");
  });

  it("does not fall back on a non-retryable error (bad request)", async () => {
    createMock.mockRejectedValueOnce(
      new OpenAI.APIError(400, undefined, "bad request", undefined),
    );

    await expect(generatePage(levers)).rejects.toThrow(/bad request/i);
    // No fallback attempt — a different model wouldn't fix a bad request.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error once the whole eligible pool is exhausted", async () => {
    createMock.mockRejectedValue(
      new OpenAI.APIError(429, undefined, "rate limited", undefined),
    );

    await expect(generatePage(levers)).rejects.toThrow(/rate limited/i);
    expect(createMock).toHaveBeenCalledTimes(2); // model-a, then model-b
  });

  it("treats an empty completion as retryable and falls back", async () => {
    // Generate-once/store-forever: a blank completion must never be returned
    // (it would crystallize as a permanently empty page).
    createMock
      .mockResolvedValueOnce(completion("   \n", 3))
      .mockResolvedValueOnce(completion("real text", 5));

    const result = await generatePage(levers);

    expect(result.text).toBe("real text");
    expect(result.model).toBe("model-b");
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("throws rather than returning empty text when every model comes back blank", async () => {
    createMock.mockResolvedValue(completion(""));

    await expect(generatePage(levers)).rejects.toThrow(/empty completion/i);
    expect(createMock).toHaveBeenCalledTimes(2); // model-a, then model-b
  });

  it("reports the actually-answering model in the result, not just the requested one", async () => {
    createMock.mockResolvedValueOnce(completion("first try", 5));
    const result = await generatePage(levers);
    expect(result.model).toBe("model-a");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("returns the exact assembled prompt it sent as the user message", async () => {
    createMock.mockResolvedValueOnce(completion("first try", 5));
    const result = await generatePage(levers);

    const expectedPrompt = buildPrompt(levers.promptVariant, {
      pageWords: levers.pageWords,
      start: levers.startPhrase,
      completeWords: levers.completeWords,
      constraints: [],
    });
    expect(result.prompt).toBe(expectedPrompt);
    expect(createMock.mock.calls[0][0]).toMatchObject({
      messages: [{ role: "user", content: expectedPrompt }],
    });
  });

  it("skips a model that is already on cooldown when building the fallback list", async () => {
    await query(
      `UPDATE model_registry SET health = 'cooling', cooling_until = now() + interval '60 seconds'
       WHERE slug = 'model-b' AND task = 'generation'`,
    );
    createMock.mockRejectedValueOnce(
      new OpenAI.APIError(429, undefined, "rate limited", undefined),
    );

    // model-a fails; model-b is cooling and excluded from the fallback pool,
    // so there's nothing left to try and the original error rethrows.
    await expect(generatePage(levers)).rejects.toThrow(/rate limited/i);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("does not park the free tier on a paid-model 429 carrying x-ratelimit-remaining: 0", async () => {
    // Ordinary per-model 429s commonly carry that header; only a `:free`
    // OpenRouter slug can mean the account-wide free-models-per-day cap.
    createMock
      .mockRejectedValueOnce(
        new OpenAI.APIError(
          429,
          undefined,
          "rate limited",
          new Headers({ "x-ratelimit-remaining": "0" }),
        ),
      )
      .mockResolvedValueOnce(completion("fallback", 5));

    await generatePage(levers);

    // Give the fire-and-forget markRateLimited (had it fired) time to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rows = await query(
      "SELECT 1 FROM model_stats WHERE model = $1 AND rate_limited_until IS NOT NULL",
      [FREE_TIER_KEY],
    );
    expect(rows).toHaveLength(0);
  });

  it("marks a 429'd model cooling so a later selection skips it", async () => {
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(429, undefined, "rate limited", undefined))
      .mockResolvedValueOnce(completion("fallback", 5));

    await generatePage(levers);

    const rows = await query<{ health: string; cooling_until: Date }>(
      "SELECT health, cooling_until FROM model_registry WHERE slug = 'model-a' AND task = 'generation'",
    );
    expect(rows[0]?.health).toBe("cooling");
    expect(rows[0]?.cooling_until.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("chooseLevers", () => {
  it("only ever picks an eligible (enabled) model", async () => {
    await query(
      "UPDATE model_registry SET enabled = false WHERE slug = 'model-b' AND task = 'generation'",
    );
    for (let i = 0; i < 20; i++) {
      const result = await chooseLevers(`addr-${i}`);
      expect(result.model).toBe("model-a");
    }
  });

  it("defaults to base-v3", async () => {
    const result = await chooseLevers("addr");
    expect(result.promptVariant).toBe("base-v3");
  });

  it("is a reproducible function of the address (same seed → same levers)", async () => {
    const a = await chooseLevers("gallery/1/2/3/4");
    const b = await chooseLevers("gallery/1/2/3/4");
    expect(b.model).toBe(a.model);
    expect(b.temperature).toBe(a.temperature);
    expect(b.constraints.map((c) => c.id)).toEqual(a.constraints.map((c) => c.id));
  });

  it("draws a different sample on a regeneration attempt", async () => {
    const first = await chooseLevers("gallery/1/2/3/4", 0);
    const retry = await chooseLevers("gallery/1/2/3/4", 1);
    // Temperature is continuous; a different seed effectively never collides.
    expect(retry.temperature).not.toBe(first.temperature);
  });

  it("samples constraints from the seed — deterministic, and address-dependent", async () => {
    // Across many addresses the constraint both fires and doesn't, proving it
    // is sampled (not always-on/off) and driven by the seed. Every dial now
    // sits at 0.15, so 200 draws makes "never fires" vanishingly unlikely
    // (0.85^200) without pinning the test to a specific probability.
    const fired = new Set<boolean>();
    for (let i = 0; i < 200; i++) {
      const levers = await chooseLevers(`addr-${i}`);
      fired.add(levers.constraints.some((c) => c.id === "no-persons"));
    }
    expect(fired).toEqual(new Set([true, false]));

    // Whatever fired is reflected in the provenance variant suffix.
    const one = await chooseLevers("addr-0");
    const expected = "base-v3" + one.constraints.map((c) => `+${c.id}`).join("");
    expect(provenanceVariant(one)).toBe(expected);
    expect(GENERATION_CONSTRAINTS.length).toBeGreaterThan(0);
  });

  it("gives every page in the library the same page size", async () => {
    // Page size is deliberately NOT a lever. It was briefly drawn per page
    // from a range, which is incoherent with the object being simulated: a
    // book does not change page size depending on where you open it, and the
    // ending only reads as "cut off" if the cut always falls in one place.
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) {
      seen.add((await chooseLevers(`g/1/1/1/${i + 1}`)).pageWords);
    }
    expect([...seen]).toEqual([config.pageWords]);
  });

  it("gives every page of a volume the same seed term", async () => {
    const first = await chooseLevers("bmw89/3/2/17/1");
    const middle = await chooseLevers("bmw89/3/2/17/206");
    const last = await chooseLevers("bmw89/3/2/17/410");
    expect(SEED_TERMS).toContain(first.seedTerm);
    expect(middle.seedTerm).toBe(first.seedTerm);
    expect(last.seedTerm).toBe(first.seedTerm);
    // ...while the page-seeded levers still vary across those same pages.
    // Temperature is the proxy: a continuous draw, so unlike the four-valued
    // edge seams it effectively never collides by chance.
    expect(middle.temperature).not.toBe(first.temperature);
  });

  it("keeps the volume's seed term across a regeneration attempt", async () => {
    // A moderation/dedup retry redraws every page-seeded lever, but the book
    // it belongs to must not change subject mid-volume.
    const first = await chooseLevers("bmw89/3/2/17/1", 0);
    const retry = await chooseLevers("bmw89/3/2/17/1", 1);
    expect(retry.seedTerm).toBe(first.seedTerm);
    expect(retry.temperature).not.toBe(first.temperature);
  });

  it("draws start and ending independently, and reproducibly", async () => {
    const pairs = new Set<string>();
    const starts = new Set<string>();
    const endings = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const l = await chooseLevers(`g/1/1/1/${i + 1}`);
      pairs.add(`${l.start}>${l.ending}`);
      starts.add(l.start);
      endings.add(l.ending);
    }
    // All four start seams and all three endings reachable...
    expect(starts.size).toBe(4);
    expect(endings.size).toBe(3);
    // ...and independent, so the pair space is wider than either alone. A
    // page's top edge has nothing to do with how it stops.
    expect(pairs.size).toBeGreaterThan(4);

    const a = await chooseLevers("gallery/1/2/3/4");
    const b = await chooseLevers("gallery/1/2/3/4");
    expect(b.start).toBe(a.start);
    expect(b.ending).toBe(a.ending);
  });

  it("draws a target length for `complete` and for nothing else", async () => {
    // A "complete" text that overruns the page gets cut, which is the one
    // outcome this ending exists to avoid — so its target sits well under one.
    let sawComplete = false;
    for (let i = 0; i < 200; i++) {
      const l = await chooseLevers(`g/1/1/1/${i + 1}`);
      if (l.ending === "complete") {
        sawComplete = true;
        expect(l.completeWords).toBeGreaterThan(0);
        expect(l.completeWords!).toBeLessThan(config.pageWords * 0.6);
      } else {
        expect(l.completeWords).toBeUndefined();
      }
    }
    expect(sawComplete).toBe(true);
  });

  it("puts the drawn start seam in the prompt, and never the ending", async () => {
    const chosen = await chooseLevers("g/1/1/1/7");
    createMock.mockResolvedValueOnce(completion("page text"));
    const result = await generatePage(chosen);
    expect(result.prompt).toContain(`It begins ${chosen.startPhrase}.`);
    // The ending is applied to the returned text (lib/pageCut.ts), never asked
    // for — a model given a word count to stop at misses it by 26-94%.
    expect(result.prompt).not.toMatch(/cut-hard|cut-soft|runs out of room/);
  });

  it("puts the seed term in the prompt but never the address", async () => {
    const chosen = await chooseLevers("bmw89/3/2/17/1");
    createMock.mockResolvedValueOnce(completion("page text"));
    const result = await generatePage(chosen);
    expect(result.prompt).toContain(`has to do with ${chosen.seedTerm}`);
    expect(result.prompt).not.toContain("bmw89");
    expect(result.prompt).not.toMatch(/\b[a-z0-9-]+\/\d+\/\d+\/\d+\/\d+\b/);
  });
});
