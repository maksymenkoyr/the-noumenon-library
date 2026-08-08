import { describe, expect, it } from "vitest";

import type { CatalogModel, RankingRow } from "./modelCatalog";
import { latestRankings } from "./modelCatalog";
import {
  DEFAULT_REVIEW_OPTIONS,
  formatDigest,
  reviewPool,
  type ModelSignal,
  type PoolRow,
  type ReviewInput,
} from "./modelReview";

const NOW = new Date("2026-08-08T06:00:00Z");

function poolRow(overrides: Partial<PoolRow> = {}): PoolRow {
  return {
    slug: "vendor/model-a",
    provider: "openrouter",
    task: "generation",
    enabled: true,
    weight: 20,
    order: 0,
    health: "ok",
    pricePerMillion: 1,
    baselinePrice: 1,
    expiresAt: null,
    trial: false,
    ...overrides,
  };
}

function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    slug: "vendor/model-a",
    canonicalSlug: "vendor/model-a-20260101",
    provider: "openrouter",
    name: "Vendor: Model A",
    description: "A general-purpose text model.",
    pricePerMillion: 1,
    promptPricePerMillion: 0.5,
    contextLength: 128_000,
    modality: "text->text",
    outputModalities: ["text"],
    supportedParameters: ["temperature", "max_tokens"],
    ...overrides,
  };
}

function ranking(overrides: Partial<RankingRow> = {}): RankingRow {
  return {
    permaslug: "vendor/model-a-20260101",
    date: "2026-08-07 00:00:00",
    count: 1_000_000,
    completionTokens: 1_000_000,
    promptTokens: 1_000_000,
    reasoningTokens: 0,
    toolCalls: 0,
    mediaPrompts: 0,
    change: 0.5,
    ...overrides,
  };
}

/** A four-model generation pool, so a single disable never hits the floor. */
function healthyPool(): PoolRow[] {
  return [
    poolRow({ slug: "vendor/a" }),
    poolRow({ slug: "vendor/b" }),
    poolRow({ slug: "vendor/c" }),
    poolRow({ slug: "vendor/d" }),
    poolRow({ slug: "vendor/mod", task: "moderation", order: 1 }),
    poolRow({ slug: "vendor/mod2", task: "moderation", order: 2 }),
  ];
}

function healthyCatalog(): CatalogModel[] {
  return ["a", "b", "c", "d", "mod", "mod2"].map((name) =>
    catalogModel({ slug: `vendor/${name}`, canonicalSlug: `vendor/${name}-20260101` }),
  );
}

function input(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    pool: healthyPool(),
    catalog: healthyCatalog(),
    rankings: null,
    signals: [],
    now: NOW,
    cataloguedProviders: ["openrouter", "google"],
    ...overrides,
  };
}

describe("price sync", () => {
  it("reprices a row whose catalog price moved", () => {
    const result = reviewPool(
      input({
        pool: [poolRow({ slug: "vendor/a", pricePerMillion: 1.32 })],
        catalog: [catalogModel({ slug: "vendor/a", pricePerMillion: 3.52 })],
      }),
    );
    const reprice = result.autoActions.find((a) => a.kind === "reprice");
    expect(reprice?.price).toBe(3.52);
    expect(reprice?.slug).toBe("vendor/a");
  });

  it("leaves google rows unpriced — that catalog reports no pricing at all", () => {
    const result = reviewPool(
      input({
        pool: [poolRow({ slug: "gemini-x", provider: "google", pricePerMillion: null })],
        catalog: [
          catalogModel({
            slug: "gemini-x",
            provider: "google",
            pricePerMillion: 0,
            canonicalSlug: undefined,
          }),
        ],
      }),
    );
    expect(result.autoActions).toHaveLength(0);
  });
});

describe("price spike guard", () => {
  it("disables a model priced past the barrier", () => {
    const pool = healthyPool();
    pool[0] = poolRow({ slug: "vendor/a", pricePerMillion: 1, baselinePrice: 1 });
    const catalog = healthyCatalog();
    catalog[0] = catalogModel({ slug: "vendor/a", pricePerMillion: 2 }); // +100%

    const result = reviewPool(input({ pool, catalog }));
    const spike = result.autoActions.find((a) => a.kind === "disable_spike");
    expect(spike?.slug).toBe("vendor/a");
    expect(spike?.reason).toContain("+100%");
  });

  it("does not fire just under the barrier", () => {
    const pool = healthyPool();
    const catalog = healthyCatalog();
    catalog[0] = catalogModel({ slug: "vendor/a", pricePerMillion: 1.4 }); // +40%
    const result = reviewPool(input({ pool, catalog }));
    expect(result.autoActions.some((a) => a.kind === "disable_spike")).toBe(false);
  });

  it("never fires on a NULL baseline — that would disable the whole pool", () => {
    const pool = healthyPool().map((r) => poolRow({ ...r, baselinePrice: null }));
    const catalog = healthyCatalog().map((m) =>
      catalogModel({ ...m, pricePerMillion: 99 }),
    );
    const result = reviewPool(input({ pool, catalog }));
    expect(result.autoActions.some((a) => a.kind === "disable_spike")).toBe(false);
  });

  it("proposes a re-baseline when the price drops materially", () => {
    const catalog = healthyCatalog();
    catalog[0] = catalogModel({ slug: "vendor/a", pricePerMillion: 0.5 }); // −50%
    const result = reviewPool(input({ catalog }));
    const drop = result.proposals.find((p) => p.action === "reprice_baseline");
    expect(drop?.slug).toBe("vendor/a");
    expect(drop?.payload.baselinePrice).toBe(0.5);
  });
});

describe("floor guard", () => {
  it("stops auto-disabling at the generation floor and escalates instead", () => {
    // Every model has tripled in price. Four enabled, floor of three.
    const pool = healthyPool().filter((r) => r.task === "generation");
    const catalog = healthyCatalog().map((m) =>
      catalogModel({ ...m, pricePerMillion: 3 }),
    );

    const result = reviewPool(input({ pool, catalog }));

    const disabled = result.autoActions.filter((a) => a.kind === "disable_spike");
    const escalated = result.proposals.filter((p) => p.action === "disable");
    expect(disabled).toHaveLength(1); // 4 → 3, and no further
    expect(escalated).toHaveLength(3);
    expect(escalated[0].urgent).toBe(true);
    expect(escalated[0].reason).toContain("NOT auto-applied");
  });

  it("holds the moderation chain at one enabled link", () => {
    const pool = [
      poolRow({ slug: "vendor/mod", task: "moderation", order: 1 }),
      poolRow({ slug: "vendor/mod2", task: "moderation", order: 2 }),
    ];
    const catalog = [
      catalogModel({ slug: "vendor/mod", pricePerMillion: 9 }),
      catalogModel({ slug: "vendor/mod2", pricePerMillion: 9 }),
    ];
    const result = reviewPool(input({ pool, catalog }));
    expect(result.autoActions.filter((a) => a.kind === "disable_spike")).toHaveLength(1);
    expect(result.proposals.filter((p) => p.action === "disable")).toHaveLength(1);
  });

  it("honours a floor raised through options", () => {
    const pool = healthyPool().filter((r) => r.task === "generation");
    const catalog = healthyCatalog().map((m) =>
      catalogModel({ ...m, pricePerMillion: 3 }),
    );
    const result = reviewPool(input({ pool, catalog, options: { minGenerationModels: 4 } }));
    expect(result.autoActions.filter((a) => a.kind === "disable_spike")).toHaveLength(0);
    expect(result.proposals.filter((p) => p.action === "disable")).toHaveLength(4);
  });
});

describe("slug death", () => {
  it("disables a row that has vanished from its provider catalog", () => {
    const pool = healthyPool();
    const catalog = healthyCatalog().filter((m) => m.slug !== "vendor/a");
    const result = reviewPool(input({ pool, catalog }));
    const dead = result.autoActions.find((a) => a.kind === "disable_dead");
    expect(dead?.slug).toBe("vendor/a");
  });

  it("treats an unreachable provider as 'no information', not 'everything died'", () => {
    const pool = [
      ...healthyPool(),
      poolRow({ slug: "gemini-x", provider: "google" }),
    ];
    const result = reviewPool(
      input({ pool, catalog: healthyCatalog(), cataloguedProviders: ["openrouter"] }),
    );
    expect(result.autoActions.some((a) => a.slug === "gemini-x")).toBe(false);
    expect(result.notes.some((n) => n.includes("google catalog unavailable"))).toBe(true);
  });

  it("ignores an already-disabled dead row", () => {
    const pool = [...healthyPool(), poolRow({ slug: "vendor/gone", enabled: false })];
    const result = reviewPool(input({ pool }));
    expect(result.autoActions.some((a) => a.slug === "vendor/gone")).toBe(false);
  });
});

describe("expiry", () => {
  it("disables a lapsed row", () => {
    const pool = [
      ...healthyPool(),
      poolRow({ slug: "vendor/temp", expiresAt: new Date("2026-08-01T00:00:00Z") }),
    ];
    const catalog = [...healthyCatalog(), catalogModel({ slug: "vendor/temp" })];
    const result = reviewPool(input({ pool, catalog }));
    const expired = result.autoActions.find((a) => a.kind === "disable_expired");
    expect(expired?.slug).toBe("vendor/temp");
  });

  it("leaves a row whose window is still open", () => {
    const pool = [
      ...healthyPool(),
      poolRow({ slug: "vendor/temp", expiresAt: new Date("2026-09-01T00:00:00Z") }),
    ];
    const catalog = [...healthyCatalog(), catalogModel({ slug: "vendor/temp" })];
    const result = reviewPool(input({ pool, catalog }));
    expect(result.autoActions.some((a) => a.kind === "disable_expired")).toBe(false);
  });

  it("applies even below the floor, but says the floor was breached", () => {
    // poolFor() already stops selecting an expired row, so withholding the
    // write would only produce a row that reads enabled but can never run.
    const pool = [
      poolRow({ slug: "vendor/a", expiresAt: new Date("2026-08-01T00:00:00Z") }),
    ];
    const result = reviewPool(input({ pool, catalog: [catalogModel({ slug: "vendor/a" })] }));
    expect(result.autoActions.filter((a) => a.kind === "disable_expired")).toHaveLength(1);
    expect(result.notes.some((n) => n.includes("below the floor"))).toBe(true);
  });
});

describe("trial verdicts", () => {
  const expiring = new Date(NOW.getTime() + 2 * 86_400_000);

  function trialInput(signals: ModelSignal[]): ReviewInput {
    const pool = [
      ...healthyPool(),
      poolRow({ slug: "vendor/trial", trial: true, weight: 5, expiresAt: expiring }),
    ];
    const catalog = [...healthyCatalog(), catalogModel({ slug: "vendor/trial" })];
    return input({ pool, catalog, signals });
  }

  const established: ModelSignal[] = ["a", "b", "c", "d"].map((n) => ({
    model: `vendor/${n}`,
    pages: 50,
    likes: 10,
    dislikes: 5,
    visits: 100,
    avgMedianDwellMs: 50_000,
  }));

  it("promotes a trial that holds readers as well as the pool", () => {
    const result = reviewPool(
      trialInput([
        ...established,
        {
          model: "vendor/trial",
          pages: 12,
          likes: 8,
          dislikes: 2,
          visits: 30,
          avgMedianDwellMs: 60_000,
        },
      ]),
    );
    const verdict = result.proposals.find((p) => p.slug === "vendor/trial");
    expect(verdict?.action).toBe("promote_trial");
  });

  it("drops a trial readers leave early", () => {
    const result = reviewPool(
      trialInput([
        ...established,
        {
          model: "vendor/trial",
          pages: 12,
          likes: 1,
          dislikes: 9,
          visits: 30,
          avgMedianDwellMs: 20_000,
        },
      ]),
    );
    const verdict = result.proposals.find((p) => p.slug === "vendor/trial");
    expect(verdict?.action).toBe("drop_trial");
    expect(verdict?.reason).toContain("pool median");
  });

  it("does not condemn a trial the lottery never drew", () => {
    const result = reviewPool(trialInput(established));
    const verdict = result.proposals.find((p) => p.slug === "vendor/trial");
    // Silence is missing evidence, not bad evidence — offer more time rather
    // than a drop, which would read identically to a genuine failure.
    expect(verdict?.action).toBe("extend_trial");
    expect(verdict?.reason).toContain("no pages generated");
    expect(verdict?.payload.extendDays).toBe(DEFAULT_REVIEW_OPTIONS.trialDays);
  });

  it("stays quiet while the trial still has time to run", () => {
    const pool = [
      ...healthyPool(),
      poolRow({
        slug: "vendor/trial",
        trial: true,
        expiresAt: new Date(NOW.getTime() + 10 * 86_400_000),
      }),
    ];
    const catalog = [...healthyCatalog(), catalogModel({ slug: "vendor/trial" })];
    const result = reviewPool(input({ pool, catalog }));
    expect(result.proposals.some((p) => p.slug === "vendor/trial")).toBe(false);
  });
});

describe("candidate gate", () => {
  /** A candidate that clears all four stages, plus the pool it competes with. */
  function candidateInput(
    model: Partial<CatalogModel> = {},
    usage: Partial<RankingRow> = {},
  ): ReviewInput {
    const candidate = catalogModel({
      slug: "vendor/new",
      canonicalSlug: "vendor/new-20260801",
      pricePerMillion: 0.4,
      ...model,
    });
    const rankings = new Map<string, RankingRow>([
      ["vendor/new-20260801", ranking({ permaslug: "vendor/new-20260801", ...usage })],
      // Two incumbents so the join-health check sees a healthy match rate.
      ["vendor/a-20260101", ranking({ permaslug: "vendor/a-20260101", count: 5_000_000 })],
      ["vendor/b-20260101", ranking({ permaslug: "vendor/b-20260101", count: 4_000_000 })],
    ]);
    return input({ catalog: [...healthyCatalog(), candidate], rankings });
  }

  it("proposes a well-ranked, growing, cheaper model as a trial", () => {
    const result = reviewPool(candidateInput());
    const trial = result.proposals.find((p) => p.action === "add_trial");
    expect(trial?.slug).toBe("vendor/new");
    expect(trial?.payload.trial).toBe(true);
    expect(trial?.payload.weight).toBe(5);
    expect(trial?.payload.trialDays).toBe(14);
    expect(trial?.reason).toContain("cheaper");
  });

  const rejectedModels: [string, Partial<CatalogModel>][] = [
    ["priced above the pool median", { pricePerMillion: 2 }],
    ["priced above the ceiling", { pricePerMillion: 99 }],
    ["too little context", { contextLength: 8_000 }],
    ["no temperature support", { supportedParameters: ["max_tokens"] }],
    ["not a text->text model", { modality: "text+image->text" }],
    ["a :free variant", { slug: "vendor/new:free" }],
    ["named as a coder model", { slug: "vendor/new-coder" }],
    ["described as a vision model", { description: "A vision language model." }],
    ["already scheduled for retirement", { expirationDate: "2026-09-01" }],
  ];

  it.each(rejectedModels)("rejects a candidate that is %s", (_label, model) => {
    const result = reviewPool(candidateInput(model));
    expect(result.proposals.some((p) => p.action === "add_trial")).toBe(false);
  });

  const rejectedUsage: [string, Partial<RankingRow>][] = [
    ["shrinking", { change: -0.2 }],
    ["flat", { change: 0 }],
    ["missing a trend", { change: null }],
    ["reasoning-first", { reasoningTokens: 900_000 }],
    ["a vision workload", { mediaPrompts: 500_000 }],
    ["an agent workload", { toolCalls: 900_000 }],
  ];

  it.each(rejectedUsage)("rejects a candidate whose usage is %s", (_label, usage) => {
    const result = reviewPool(candidateInput({}, usage));
    expect(result.proposals.some((p) => p.action === "add_trial")).toBe(false);
  });

  it("rejects a candidate nobody uses", () => {
    const result = reviewPool(candidateInput({}, { count: 1 }));
    // Rank floor is 100; with only three ranked models it still places, so
    // tighten the floor to prove the gate rather than the fixture.
    const strict = reviewPool({ ...candidateInput({}, { count: 1 }), options: { maxCandidateRank: 2 } });
    expect(strict.proposals.some((p) => p.action === "add_trial")).toBe(false);
    expect(result.proposals.some((p) => p.action === "add_trial")).toBe(true);
  });

  it("never proposes a model already in the pool", () => {
    const result = reviewPool(candidateInput({ slug: "vendor/a" }));
    expect(result.proposals.some((p) => p.action === "add_trial")).toBe(false);
  });

  it("caps how many it suggests at once", () => {
    const extras = Array.from({ length: 8 }, (_, i) =>
      catalogModel({
        slug: `vendor/new${i}`,
        canonicalSlug: `vendor/new${i}-2026`,
        pricePerMillion: 0.4,
      }),
    );
    const rankings = new Map<string, RankingRow>(
      extras.map((m, i) => [
        m.canonicalSlug!,
        ranking({ permaslug: m.canonicalSlug!, count: 1_000_000 - i }),
      ]),
    );
    const result = reviewPool(
      input({ catalog: [...healthyCatalog(), ...extras], rankings }),
    );
    expect(result.proposals.filter((p) => p.action === "add_trial")).toHaveLength(3);
  });

  it("degrades to safety-actions-only when the rankings feed is down", () => {
    const catalog = healthyCatalog();
    catalog[0] = catalogModel({ slug: "vendor/a", pricePerMillion: 5 }); // still spikes
    const result = reviewPool(input({ catalog, rankings: null }));
    expect(result.proposals.some((p) => p.action === "add_trial")).toBe(false);
    expect(result.autoActions.some((a) => a.kind === "disable_spike")).toBe(true);
    expect(result.notes.some((n) => n.includes("rankings unavailable"))).toBe(true);
  });

  it("warns when our own models fall out of the rankings join", () => {
    // Rankings keyed on permaslugs that match nothing we run — the silent
    // failure mode this check exists to make loud.
    const rankings = new Map<string, RankingRow>([
      ["someone/else-20260101", ranking({ permaslug: "someone/else-20260101" })],
    ]);
    const result = reviewPool(input({ rankings }));
    expect(result.notes.some((n) => n.includes("rankings join matched only"))).toBe(true);
  });
});

describe("provider-announced retirement", () => {
  it("raises an urgent swap proposal", () => {
    const catalog = healthyCatalog();
    catalog[0] = catalogModel({ slug: "vendor/a", expirationDate: "2026-10-01" });
    const result = reviewPool(input({ catalog }));
    const swap = result.proposals.find((p) => p.action === "swap");
    expect(swap?.slug).toBe("vendor/a");
    expect(swap?.urgent).toBe(true);
    expect(result.proposals[0].urgent).toBe(true); // urgent leads the digest
  });
});

describe("latestRankings", () => {
  it("keeps only the most recent day", () => {
    const merged = latestRankings([
      ranking({ permaslug: "x", date: "2026-08-01 00:00:00", count: 5 }),
      ranking({ permaslug: "x", date: "2026-08-07 00:00:00", count: 9 }),
    ]);
    expect(merged.get("x")?.count).toBe(9);
  });

  it("sums the request variants of one model", () => {
    // standard + free + batch describe the same model; counting only one
    // undercounts adoption and hides the reasoning-token tell.
    const merged = latestRankings([
      ranking({ permaslug: "x", count: 100, reasoningTokens: 10, change: 0.5 }),
      ranking({ permaslug: "x", count: 40, reasoningTokens: 5, change: 0.1 }),
    ]);
    expect(merged.get("x")?.count).toBe(140);
    expect(merged.get("x")?.reasoningTokens).toBe(15);
    // `change` is a ratio: carried from the dominant variant, never summed.
    expect(merged.get("x")?.change).toBe(0.5);
  });

  it("keeps two dated versions of a family apart", () => {
    const merged = latestRankings([
      ranking({ permaslug: "vendor/m-20260423", count: 10 }),
      ranking({ permaslug: "vendor/m-20260731", count: 20 }),
    ]);
    expect(merged.size).toBe(2);
  });
});

describe("formatDigest", () => {
  it("carries the full reasoning, not a teaser", () => {
    const catalog = healthyCatalog();
    catalog[0] = catalogModel({ slug: "vendor/a", pricePerMillion: 4 });
    const result = reviewPool(input({ catalog }));
    const text = formatDigest(result, {
      date: "2026-08-08",
      dashboardUrl: "https://example.test/operator",
    });
    expect(text).toContain("Model pool — 2026-08-08");
    expect(text).toContain("APPLIED");
    expect(text).toContain("vendor/a");
    expect(text).toContain("+300%");
  });

  it("says so plainly when nothing changed", () => {
    const text = formatDigest({ autoActions: [], proposals: [], notes: [] }, {
      date: "2026-08-08",
    });
    expect(text).toContain("No changes");
  });

  it("truncates to Telegram's limit and points at the dashboard", () => {
    const proposals = Array.from({ length: 400 }, (_, i) => ({
      action: "add_trial" as const,
      slug: `vendor/model-${i}`,
      provider: "openrouter" as const,
      task: "generation" as const,
      reason: "x".repeat(80),
      payload: {},
    }));
    const text = formatDigest(
      { autoActions: [], proposals, notes: [] },
      { date: "2026-08-08", dashboardUrl: "https://example.test/operator" },
    );
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("truncated");
  });
});
