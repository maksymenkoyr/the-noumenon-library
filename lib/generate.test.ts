import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // A small, known pool so fallback order is deterministic to assert on: two
  // free models plus a single paid safety-net model.
  process.env.GENERATION_MODELS = "model-a:free,model-b:free";
  process.env.PAID_GENERATION_MODELS = "model-paid:paid";
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

const createMock = vi.fn();
vi.mock("./openrouter", () => ({
  getOpenRouter: () => ({ chat: { completions: { create: createMock } } }),
}));

// Mock only the DB-touching parts of modelStats; keep the real cooldown
// helpers (freeTierOnCooldown/modelOnCooldown) so their logic is genuinely
// exercised against whatever Map a test hands to getModelStats. vi.hoisted
// is required here — vi.mock's factory is hoisted above regular top-level
// const declarations, so it can only close over vi.hoisted() bindings.
const { getModelStatsMock, recordModelCallMock, markRateLimitedMock } = vi.hoisted(() => ({
  getModelStatsMock: vi.fn(async () => new Map()),
  recordModelCallMock: vi.fn(async () => {}),
  markRateLimitedMock: vi.fn(async () => {}),
}));
vi.mock("./modelStats", async () => {
  const actual = await vi.importActual<typeof import("./modelStats")>("./modelStats");
  return {
    ...actual,
    getModelStats: getModelStatsMock,
    recordModelCall: recordModelCallMock,
    markRateLimited: markRateLimitedMock,
  };
});

import { chooseLevers, generatePage, type GenerationLevers } from "./generate";
import { FREE_TIER_KEY } from "./modelStats";

/** A minimal fake OpenAI chat completion. */
function completion(content: string, totalTokens = 0) {
  return { choices: [{ message: { content } }], usage: { total_tokens: totalTokens } };
}

const levers: GenerationLevers = {
  model: "model-a:free",
  temperature: 0.9,
  promptVariant: "base-v2",
  form: "a field guide entry",
};

beforeEach(() => {
  createMock.mockReset();
  getModelStatsMock.mockReset().mockResolvedValue(new Map());
  recordModelCallMock.mockReset().mockResolvedValue(undefined);
  markRateLimitedMock.mockReset().mockResolvedValue(undefined);
});

describe("generatePage fallback", () => {
  it("falls back to the next pool model on a retryable error (429)", async () => {
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(429, undefined, "rate limited", undefined))
      .mockResolvedValueOnce(completion("fallback text", 42));

    const result = await generatePage(levers);

    expect(result.text).toBe("fallback text");
    expect(result.model).toBe("model-b:free");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0]).toMatchObject({ model: "model-a:free" });
    expect(createMock.mock.calls[1][0]).toMatchObject({ model: "model-b:free" });
  });

  it("falls back on a 5xx and on a connection error, not just 429", async () => {
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(503, undefined, "unavailable", undefined))
      .mockResolvedValueOnce(completion("recovered", 10));
    const result = await generatePage(levers);
    expect(result.model).toBe("model-b:free");

    createMock.mockReset();
    createMock
      .mockRejectedValueOnce(new OpenAI.APIConnectionError({ message: "ECONNRESET" }))
      .mockResolvedValueOnce(completion("recovered again", 10));
    const result2 = await generatePage(levers);
    expect(result2.model).toBe("model-b:free");
  });

  it("does not fall back on a non-retryable error (bad request)", async () => {
    createMock.mockRejectedValueOnce(
      new OpenAI.APIError(400, undefined, "bad request", undefined),
    );

    await expect(generatePage(levers)).rejects.toThrow(/bad request/i);
    // No fallback attempt — a different model wouldn't fix a bad request.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error once the whole pool (free + paid) is exhausted", async () => {
    createMock.mockRejectedValue(
      new OpenAI.APIError(429, undefined, "rate limited", undefined),
    );

    await expect(generatePage(levers)).rejects.toThrow(/rate limited/i);
    // model-a, model-b, and the paid safety net all tried.
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it("reports the actually-answering model in the result, not just the requested one", async () => {
    createMock.mockResolvedValueOnce(completion("first try", 5));
    const result = await generatePage(levers);
    expect(result.model).toBe("model-a:free");
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("records each attempt's outcome to model_stats, fire-and-forget", async () => {
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(429, undefined, "rate limited", undefined))
      .mockResolvedValueOnce(completion("ok", 5));

    await generatePage(levers);

    expect(recordModelCallMock).toHaveBeenCalledWith(
      "model-a:free",
      expect.objectContaining({ ok: false }),
    );
    expect(recordModelCallMock).toHaveBeenCalledWith(
      "model-b:free",
      expect.objectContaining({ ok: true }),
    );
  });

  it(
    "on the account-wide free-cap 429, skips the rest of the free pool and " +
      "jumps straight to the paid model",
    async () => {
      createMock
        .mockRejectedValueOnce(
          new OpenAI.APIError(
            429,
            undefined,
            "Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
            undefined,
          ),
        )
        .mockResolvedValueOnce(completion("paid tier saved the day", 20));

      const result = await generatePage(levers);

      expect(result.model).toBe("model-paid:paid");
      // model-b:free was never called — only model-a (failed) then the paid model.
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(createMock.mock.calls[0][0]).toMatchObject({ model: "model-a:free" });
      expect(createMock.mock.calls[1][0]).toMatchObject({ model: "model-paid:paid" });
      expect(markRateLimitedMock).toHaveBeenCalledWith(FREE_TIER_KEY, expect.any(Number));
    },
  );

  it("also detects the account-wide free-cap via the rate-limit header when the message text doesn't mention it", async () => {
    const headers = { get: (name: string) => (name === "x-ratelimit-remaining" ? "0" : null) };
    createMock
      .mockRejectedValueOnce(
        new OpenAI.APIError(429, undefined, "too many requests", headers as unknown as Headers),
      )
      .mockResolvedValueOnce(completion("paid tier saved the day", 20));

    const result = await generatePage(levers);

    expect(result.model).toBe("model-paid:paid");
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("skips a free pool model that is individually on cooldown when building the fallback list", async () => {
    getModelStatsMock.mockResolvedValue(
      new Map([["model-b:free", { avgMs: undefined, rateLimitedUntil: new Date(Date.now() + 60_000) }]]),
    );
    createMock
      .mockRejectedValueOnce(new OpenAI.APIError(429, undefined, "rate limited", undefined))
      .mockResolvedValueOnce(completion("paid picked up the slack", 8));

    const result = await generatePage(levers);

    expect(result.model).toBe("model-paid:paid");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[1][0]).toMatchObject({ model: "model-paid:paid" });
  });
});

describe("chooseLevers", () => {
  it("prefers the paid model when the account-wide free-cap cooldown is active", async () => {
    getModelStatsMock.mockResolvedValue(
      new Map([[FREE_TIER_KEY, { avgMs: undefined, rateLimitedUntil: new Date(Date.now() + 60_000) }]]),
    );

    const result = await chooseLevers();
    expect(result.model).toBe("model-paid:paid");
  });

  it("falls back to the paid model when every free pool model is individually on cooldown", async () => {
    const future = new Date(Date.now() + 60_000);
    getModelStatsMock.mockResolvedValue(
      new Map([
        ["model-a:free", { avgMs: undefined, rateLimitedUntil: future }],
        ["model-b:free", { avgMs: undefined, rateLimitedUntil: future }],
      ]),
    );

    const result = await chooseLevers();
    expect(result.model).toBe("model-paid:paid");
  });

  it("latency-weighted pick strongly favors the faster free model over many trials", async () => {
    getModelStatsMock.mockResolvedValue(
      new Map([
        ["model-a:free", { avgMs: 50, rateLimitedUntil: undefined }],
        ["model-b:free", { avgMs: 5000, rateLimitedUntil: undefined }],
      ]),
    );

    const picks = await Promise.all(Array.from({ length: 200 }, () => chooseLevers()));
    const countA = picks.filter((l) => l.model === "model-a:free").length;
    const countB = picks.filter((l) => l.model === "model-b:free").length;

    // 1/50 vs 1/5000 weighting is a ~100:1 tilt — a 5:1 threshold leaves no
    // realistic flakiness while still proving the weighting is in effect.
    expect(countA).toBeGreaterThan(countB * 5);
  });

  it("still samples a model with no latency data yet at a neutral weight", async () => {
    // model-a has data, model-b has none — model-b should not be starved out.
    getModelStatsMock.mockResolvedValue(
      new Map([["model-a:free", { avgMs: 5000, rateLimitedUntil: undefined }]]),
    );

    const picks = await Promise.all(Array.from({ length: 200 }, () => chooseLevers()));
    const countB = picks.filter((l) => l.model === "model-b:free").length;

    expect(countB).toBeGreaterThan(0);
  });
});
