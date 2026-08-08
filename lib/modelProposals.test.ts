import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Same hoisting reason as lib/registry.test.ts: lib/config.ts reads these at
// module-evaluation time, which ESM runs before this file's top-level code.
vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

import { closePool, query } from "./db";
import { decideProposals, listPendingProposals } from "./modelProposals";

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await query("TRUNCATE model_registry");
  await query("TRUNCATE model_proposals");
});

afterAll(async () => {
  await closePool();
});

const RUN = "11111111-1111-1111-1111-111111111111";

async function seedProposal(
  action: string,
  overrides: {
    slug?: string;
    task?: string;
    provider?: string;
    payload?: Record<string, unknown>;
  } = {},
): Promise<number> {
  const rows = await query<{ id: string }>(
    `INSERT INTO model_proposals (run_id, slug, provider, task, action, reason, payload)
     VALUES ($1, $2, $3, $4, $5, 'because', $6::jsonb) RETURNING id`,
    [
      RUN,
      overrides.slug ?? "vendor/candidate",
      overrides.provider ?? "openrouter",
      overrides.task ?? "generation",
      action,
      JSON.stringify(overrides.payload ?? {}),
    ],
  );
  return Number(rows[0].id);
}

async function seedModel(
  slug: string,
  overrides: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  const columns = {
    enabled: true,
    weight: 20,
    trial: false,
    task: "generation",
    ...overrides,
  };
  await query(
    `INSERT INTO model_registry (slug, provider, task, enabled, weight, temperature,
                                 max_tokens, reasoning_enabled, trial)
     VALUES ($1, 'openrouter', $2, $3, $4, 0.9, 1000, false, $5)`,
    [slug, columns.task, columns.enabled, columns.weight, columns.trial],
  );
}

async function registryRow(slug: string, task = "generation") {
  const rows = await query<{
    enabled: boolean;
    weight: number;
    trial: boolean;
    expires_at: Date | null;
    price_per_million: string | null;
    baseline_price: string | null;
  }>(
    `SELECT enabled, weight, trial, expires_at, price_per_million, baseline_price
       FROM model_registry WHERE slug = $1 AND task = $2`,
    [slug, task],
  );
  return rows[0];
}

async function statusOf(id: number): Promise<string> {
  const rows = await query<{ status: string }>(
    "SELECT status FROM model_proposals WHERE id = $1",
    [id],
  );
  return rows[0].status;
}

describe("listPendingProposals", () => {
  it("returns only undecided rows", async () => {
    const pending = await seedProposal("add_trial");
    const decided = await seedProposal("add_trial", { slug: "vendor/other" });
    await query("UPDATE model_proposals SET status = 'applied' WHERE id = $1", [decided]);

    const rows = await listPendingProposals();
    expect(rows.map((r) => r.id)).toEqual([pending]);
    expect(rows[0].payload).toEqual({});
  });
});

describe("add_trial", () => {
  it("creates an enabled, time-boxed trial row", async () => {
    await seedModel("vendor/incumbent");
    const id = await seedProposal("add_trial", {
      payload: { weight: 5, trialDays: 14, pricePerMillion: 0.4 },
    });

    const result = await decideProposals([id], "apply");

    expect(result.applied).toEqual([id]);
    const row = await registryRow("vendor/candidate");
    expect(row.enabled).toBe(true);
    expect(row.weight).toBe(5);
    expect(row.trial).toBe(true);
    expect(Number(row.price_per_million)).toBe(0.4);
    // The baseline is stamped at the moment of choosing, so the spike guard
    // measures future prices against what we actually agreed to pay.
    expect(Number(row.baseline_price)).toBe(0.4);
    expect(row.expires_at).not.toBeNull();
    expect(row.expires_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await statusOf(id)).toBe("applied");
  });

  it("re-enables a model that was tried and dropped before", async () => {
    // DO NOTHING here would report success while changing nothing.
    await seedModel("vendor/candidate", { enabled: false, weight: 0 });
    const id = await seedProposal("add_trial", {
      payload: { weight: 5, trialDays: 7, pricePerMillion: 1 },
    });

    await decideProposals([id], "apply");

    const row = await registryRow("vendor/candidate");
    expect(row.enabled).toBe(true);
    expect(row.weight).toBe(5);
    expect(row.trial).toBe(true);
  });
});

describe("trial lifecycle", () => {
  it("promote_trial takes the row off the clock", async () => {
    await seedModel("vendor/candidate", { trial: true, weight: 5 });
    await query(
      "UPDATE model_registry SET expires_at = now() + interval '2 days' WHERE slug = 'vendor/candidate'",
    );
    const id = await seedProposal("promote_trial", { payload: { weight: 10 } });

    await decideProposals([id], "apply");

    const row = await registryRow("vendor/candidate");
    expect(row.trial).toBe(false);
    expect(row.expires_at).toBeNull();
    expect(row.weight).toBe(10);
    expect(row.enabled).toBe(true);
  });

  it("extend_trial buys the full window from now", async () => {
    await seedModel("vendor/candidate", { trial: true, weight: 5 });
    await query(
      "UPDATE model_registry SET expires_at = now() + interval '1 day' WHERE slug = 'vendor/candidate'",
    );
    const id = await seedProposal("extend_trial", { payload: { extendDays: 14 } });

    await decideProposals([id], "apply");

    const row = await registryRow("vendor/candidate");
    const daysOut = (row.expires_at!.getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(13);
  });

  it("drop_trial disables the row", async () => {
    await seedModel("vendor/incumbent");
    await seedModel("vendor/candidate", { trial: true, weight: 5 });
    const id = await seedProposal("drop_trial");

    await decideProposals([id], "apply");

    expect((await registryRow("vendor/candidate")).enabled).toBe(false);
  });
});

describe("reprice_baseline", () => {
  it("moves the spike guard's reference to the new price", async () => {
    await seedModel("vendor/candidate");
    await query(
      "UPDATE model_registry SET baseline_price = 3.52 WHERE slug = 'vendor/candidate'",
    );
    const id = await seedProposal("reprice_baseline", {
      payload: { baselinePrice: 0.57 },
    });

    await decideProposals([id], "apply");

    expect(Number((await registryRow("vendor/candidate")).baseline_price)).toBe(0.57);
  });
});

describe("safety", () => {
  it("refuses to disable the last enabled generation model", async () => {
    await seedModel("vendor/only");
    const id = await seedProposal("disable", { slug: "vendor/only" });

    const result = await decideProposals([id], "apply");

    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toContain("no enabled generation models");
    // Refused, not silently swallowed: the row is still enabled AND still
    // pending, so the operator sees it again rather than believing it landed.
    expect((await registryRow("vendor/only")).enabled).toBe(true);
    expect(await statusOf(id)).toBe("pending");
  });

  it("stops a select-all from emptying the pool", async () => {
    await seedModel("vendor/a");
    await seedModel("vendor/b");
    await seedModel("vendor/c");
    const ids = await Promise.all([
      seedProposal("disable", { slug: "vendor/a" }),
      seedProposal("disable", { slug: "vendor/b" }),
      seedProposal("disable", { slug: "vendor/c" }),
    ]);

    const result = await decideProposals(ids, "apply");

    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    const enabled = await query<{ count: string }>(
      "SELECT count(*) AS count FROM model_registry WHERE task = 'generation' AND enabled = true",
    );
    expect(Number(enabled[0].count)).toBe(1);
  });

  it("does not count a moderation disable against the generation floor", async () => {
    await seedModel("vendor/gen");
    await seedModel("vendor/mod", { task: "moderation" });
    const id = await seedProposal("disable", { slug: "vendor/mod", task: "moderation" });

    const result = await decideProposals([id], "apply");

    expect(result.applied).toEqual([id]);
    expect((await registryRow("vendor/gen")).enabled).toBe(true);
  });

  it("never auto-applies an informational swap", async () => {
    await seedModel("vendor/candidate");
    const id = await seedProposal("swap", { payload: { expirationDate: "2026-10-01" } });

    const result = await decideProposals([id], "apply");

    expect(result.applied).toEqual([]);
    expect(result.skipped[0].reason).toContain("manual decision");
    expect((await registryRow("vendor/candidate")).enabled).toBe(true);
  });

  it("ignores ids that are not pending", async () => {
    const id = await seedProposal("add_trial");
    await query("UPDATE model_proposals SET status = 'superseded' WHERE id = $1", [id]);

    const result = await decideProposals([id], "apply");

    expect(result.applied).toEqual([]);
    expect(await registryRow("vendor/candidate")).toBeUndefined();
  });
});

describe("reject", () => {
  it("records the decision without touching the pool", async () => {
    await seedModel("vendor/incumbent");
    const id = await seedProposal("add_trial", { payload: { weight: 5 } });

    const result = await decideProposals([id], "reject");

    expect(result.rejected).toEqual([id]);
    expect(await statusOf(id)).toBe("rejected");
    expect(await registryRow("vendor/candidate")).toBeUndefined();
    expect(await listPendingProposals()).toEqual([]);
  });
});
