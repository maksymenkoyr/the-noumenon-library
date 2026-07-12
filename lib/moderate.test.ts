import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
  // poolFor()/moderationChain() require a configured key for a row's
  // provider to be eligible — both seeded rows below are openrouter.
  process.env.OPENROUTER_API_KEY = "test-key";
});

const createMock = vi.fn();
vi.mock("./providers", async () => {
  const actual = await vi.importActual<typeof import("./providers")>("./providers");
  return { ...actual, getClient: () => ({ chat: { completions: { create: createMock } } }) };
});

import { closePool, query } from "./db";
import { moderate } from "./moderate";

/** Build a fake completion whose content is `reply`. */
function reply(content: string) {
  return { choices: [{ message: { content } }] };
}

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  createMock.mockReset();
  await query("TRUNCATE model_registry");
  // A known 2-model chain, order 1 then order 2 — mirrors the seeded shape
  // (docs/architecture.md §7) without depending on the real seed slugs.
  await query(
    `INSERT INTO model_registry (slug, provider, task, enabled, "order", temperature, max_tokens)
     VALUES
       ('model-a', 'openrouter', 'moderation', true, 1, 0, 5),
       ('model-b', 'openrouter', 'moderation', true, 2, 0, 5)`,
  );
});

afterAll(async () => {
  await closePool();
});

describe("moderate (chain)", () => {
  it("decides from the first model's clear PASS — exactly one call", async () => {
    createMock.mockResolvedValue(reply("PASS"));
    expect(await moderate("a calm page")).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0]).toMatchObject({ model: "model-a" });
  });

  it("decides from the first model's clear FAIL — exactly one call", async () => {
    createMock.mockResolvedValue(reply("FAIL"));
    expect(await moderate("bad page")).toEqual({ ok: false });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("does not misread UNSAFE-style strings: an unclear reply abstains, falling through", async () => {
    createMock
      .mockResolvedValueOnce(reply("hmm, PASS or FAIL? unclear"))
      .mockResolvedValueOnce(reply("PASS"));
    expect(await moderate("ambiguous")).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[1][0]).toMatchObject({ model: "model-b" });
  });

  it("falls through to the next model in the chain on a primary-model error (outage)", async () => {
    createMock
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(reply("PASS"));
    expect(await moderate("page")).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("throws and stores nothing when every model in the chain abstains or errors (total outage)", async () => {
    createMock.mockRejectedValue(new Error("all down"));
    await expect(moderate("page")).rejects.toThrow(/undetermined/i);
    expect(createMock).toHaveBeenCalledTimes(2); // tried both links, then gave up
  });

  it("throws when the chain is empty (no eligible model)", async () => {
    await query("TRUNCATE model_registry");
    await expect(moderate("page")).rejects.toThrow(/undetermined/i);
    expect(createMock).not.toHaveBeenCalled();
  });
});
