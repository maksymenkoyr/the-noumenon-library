import { describe, expect, it } from "vitest";

import { reasoningParams } from "./providers";

describe("reasoningParams", () => {
  it("google: sends reasoning_effort at the top level, not wrapped in extra_body", () => {
    // Regression test: extra_body is an OpenAI *Python* SDK convention (Python
    // unpacks it into the request body). The TS SDK has no such feature — it
    // serializes unknown keys verbatim, so an `extra_body` wrapper ships as a
    // literal top-level field on the wire. Google's OpenAI-compat gateway
    // rejects that with a bodyless 400 (reproduced against the live endpoint;
    // the identical body without the wrapper returns 200).
    const params = reasoningParams("google");
    expect(params).not.toHaveProperty("extra_body");
    expect(params).toEqual({ reasoning_effort: "none" });
  });

  it("openrouter: sends the unified top-level reasoning field", () => {
    const params = reasoningParams("openrouter");
    expect(params).toEqual({ reasoning: { enabled: false } });
  });
});
