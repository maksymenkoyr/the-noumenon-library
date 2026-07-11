import OpenAI from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // A small, known pool so fallback order is deterministic to assert on.
  process.env.GENERATION_MODELS = "model-a:free,model-b:free";
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

const createMock = vi.fn();
vi.mock("./openrouter", () => ({
  getOpenRouter: () => ({ chat: { completions: { create: createMock } } }),
}));

import { generatePage, type GenerationLevers } from "./generate";

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

  it("rethrows the last error once the whole pool is exhausted", async () => {
    createMock.mockRejectedValue(
      new OpenAI.APIError(429, undefined, "rate limited", undefined),
    );

    await expect(generatePage(levers)).rejects.toThrow(/rate limited/i);
    expect(createMock).toHaveBeenCalledTimes(2); // both pool models tried
  });

  it("reports the actually-answering model in the result, not just the requested one", async () => {
    createMock.mockResolvedValueOnce(completion("first try", 5));
    const result = await generatePage(levers);
    expect(result.model).toBe("model-a:free");
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
