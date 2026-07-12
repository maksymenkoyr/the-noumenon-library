import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// config.openrouterApiKey/googleApiKey are read eagerly at module-evaluation
// time (lib/config.ts), which — per ESM import hoisting — happens before this
// file's own top-level statements run. vi.hoisted forces these env writes to
// happen first, before ./registry (and transitively ./config) is imported.
vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  // Only openrouter has a key in this file — used by the "missing provider
  // key" test below, which relies on GOOGLE_API_KEY staying unset.
  process.env.OPENROUTER_API_KEY = "test-key";
});

import { closePool, query } from "./db";
import type { ModelStat } from "./modelStats";
import {
  chooseGenerationModel,
  moderationChain,
  poolFor,
  weightedPick,
  type RegistryRow,
} from "./registry";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE model_registry");
});

afterAll(async () => {
  await closePool();
});

function row(overrides: Partial<RegistryRow> = {}): RegistryRow {
  return {
    slug: "model-a",
    provider: "openrouter",
    task: "generation",
    weight: 10,
    order: 0,
    temperature: 0.9,
    maxTokens: 1000,
    ...overrides,
  };
}

interface SeedRow {
  slug: string;
  provider: "openrouter" | "google";
  task: "generation" | "moderation";
  enabled?: boolean;
  weight?: number;
  order?: number;
  temperature?: number;
  max_tokens?: number;
  health?: "ok" | "cooling" | "unavailable";
  cooling_until?: Date | null;
}

async function seed(rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    await query(
      `INSERT INTO model_registry
         (slug, provider, task, enabled, weight, "order", temperature, max_tokens, health, cooling_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.slug,
        r.provider,
        r.task,
        r.enabled ?? true,
        r.weight ?? 10,
        r.order ?? 0,
        r.temperature ?? 0.9,
        r.max_tokens ?? 1000,
        r.health ?? "ok",
        r.cooling_until ?? null,
      ],
    );
  }
}

describe("weightedPick", () => {
  it("distributes ~1000 draws proportionally to configured weight", () => {
    const rows = [
      row({ slug: "a", weight: 20 }),
      row({ slug: "b", weight: 20 }),
      row({ slug: "c", weight: 10 }),
    ];
    const stats = new Map<string, ModelStat>();
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 1000; i++) {
      counts[weightedPick(rows, stats).slug]++;
    }
    // Expected ratio 40% / 40% / 20% — generous tolerance for sampling noise.
    expect(counts.a).toBeGreaterThan(300);
    expect(counts.a).toBeLessThan(500);
    expect(counts.b).toBeGreaterThan(300);
    expect(counts.b).toBeLessThan(500);
    expect(counts.c).toBeGreaterThan(120);
    expect(counts.c).toBeLessThan(280);
  });

  it("never selects a model weighted at 0", () => {
    const rows = [row({ slug: "live", weight: 20 }), row({ slug: "disabled", weight: 0 })];
    const stats = new Map<string, ModelStat>();
    for (let i = 0; i < 200; i++) {
      expect(weightedPick(rows, stats).slug).toBe("live");
    }
  });

  it("bounds the latency tiebreak — it cannot overturn the configured weight ratio", () => {
    // 'slow' is configured at 4x the weight of 'fast' but is far slower —
    // the clamped (0.8–1.25x) tiebreak must not flip the outcome.
    const rows = [row({ slug: "slow", weight: 40 }), row({ slug: "fast", weight: 10 })];
    const stats = new Map<string, ModelStat>([
      ["slow", { avgMs: 20000, rateLimitedUntil: undefined }],
      ["fast", { avgMs: 100, rateLimitedUntil: undefined }],
    ]);
    let slow = 0;
    let fast = 0;
    for (let i = 0; i < 1000; i++) {
      if (weightedPick(rows, stats).slug === "slow") slow++;
      else fast++;
    }
    expect(slow).toBeGreaterThan(fast); // configured weight still dominates
  });
});

describe("poolFor", () => {
  it("excludes a disabled model", async () => {
    await seed([
      { slug: "live", provider: "openrouter", task: "generation" },
      { slug: "off", provider: "openrouter", task: "generation", enabled: false },
    ]);
    expect((await poolFor("generation")).map((r) => r.slug)).toEqual(["live"]);
  });

  it("excludes an unavailable model", async () => {
    await seed([
      { slug: "live", provider: "openrouter", task: "generation" },
      { slug: "gone", provider: "openrouter", task: "generation", health: "unavailable" },
    ]);
    expect((await poolFor("generation")).map((r) => r.slug)).toEqual(["live"]);
  });

  it("excludes a model whose provider has no configured key", async () => {
    await seed([
      { slug: "live", provider: "openrouter", task: "generation" },
      { slug: "no-key", provider: "google", task: "generation" }, // GOOGLE_API_KEY unset
    ]);
    expect((await poolFor("generation")).map((r) => r.slug)).toEqual(["live"]);
  });

  it("excludes a cooling model until its window passes, then re-admits it with no cron", async () => {
    await seed([
      { slug: "live", provider: "openrouter", task: "generation" },
      {
        slug: "cooling-active",
        provider: "openrouter",
        task: "generation",
        health: "cooling",
        cooling_until: new Date(Date.now() + 60_000),
      },
      {
        slug: "cooling-expired",
        provider: "openrouter",
        task: "generation",
        health: "cooling",
        cooling_until: new Date(Date.now() - 1000),
      },
    ]);
    expect((await poolFor("generation")).map((r) => r.slug).sort()).toEqual([
      "cooling-expired",
      "live",
    ]);
  });

  it("keeps tasks separate — a moderation row never appears in the generation pool", async () => {
    await seed([
      { slug: "gen-model", provider: "openrouter", task: "generation" },
      { slug: "mod-model", provider: "openrouter", task: "moderation" },
    ]);
    expect((await poolFor("generation")).map((r) => r.slug)).toEqual(["gen-model"]);
    expect((await poolFor("moderation")).map((r) => r.slug)).toEqual(["mod-model"]);
  });
});

describe("chooseGenerationModel", () => {
  it("throws when nothing is eligible", async () => {
    await expect(chooseGenerationModel(new Map())).rejects.toThrow(/no eligible/i);
  });

  it("only ever selects an eligible row", async () => {
    await seed([
      { slug: "live", provider: "openrouter", task: "generation", weight: 20 },
      { slug: "off", provider: "openrouter", task: "generation", weight: 20, enabled: false },
    ]);
    const chosen = await chooseGenerationModel(new Map());
    expect(chosen.slug).toBe("live");
  });
});

describe("moderationChain", () => {
  it("sorts by order", async () => {
    await seed([
      { slug: "second", provider: "openrouter", task: "moderation", order: 2 },
      { slug: "first", provider: "openrouter", task: "moderation", order: 1 },
    ]);
    expect((await moderationChain()).map((r) => r.slug)).toEqual(["first", "second"]);
  });
});
