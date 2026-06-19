import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // A small, known pool so behavior is deterministic regardless of defaults.
  process.env.MODERATION_MODELS = "model-a@0,model-b@0";
  process.env.MODERATION_POLICY = "any-fail";
  // moderate() needs DATABASE_URL only transitively via config; set for safety.
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/noumenon_test";
});

const createMock = vi.fn();
vi.mock("./openrouter", () => ({
  getOpenRouter: () => ({ chat: { completions: { create: createMock } } }),
}));

import { combineVerdicts, moderate, type Verdict } from "./moderate";

/** Build a fake completion whose content is `reply`. */
function reply(content: string) {
  return { choices: [{ message: { content } }] };
}

beforeEach(() => {
  createMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("combineVerdicts", () => {
  const v = (s: string) => s as Verdict;

  it("any-fail: fails if any model fails", () => {
    expect(combineVerdicts([v("pass"), v("fail")], "any-fail")).toEqual({ ok: false });
    expect(combineVerdicts([v("pass"), v("pass")], "any-fail")).toEqual({ ok: true });
  });

  it("unanimous-fail: passes unless all fail", () => {
    expect(combineVerdicts([v("fail"), v("fail")], "unanimous-fail")).toEqual({ ok: false });
    expect(combineVerdicts([v("fail"), v("pass")], "unanimous-fail")).toEqual({ ok: true });
  });

  it("majority: fails only when fails outnumber passes", () => {
    expect(combineVerdicts([v("fail"), v("fail"), v("pass")], "majority")).toEqual({ ok: false });
    expect(combineVerdicts([v("pass"), v("fail")], "majority")).toEqual({ ok: true });
  });
});

describe("moderate (pool + parsing, any-fail policy)", () => {
  it("passes when all models reply PASS", async () => {
    createMock.mockResolvedValue(reply("PASS"));
    expect(await moderate("a calm page")).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("fails (any-fail) when one model replies FAIL", async () => {
    createMock
      .mockResolvedValueOnce(reply("PASS"))
      .mockResolvedValueOnce(reply("FAIL"));
    expect(await moderate("bad page")).toEqual({ ok: false });
  });

  it("does not misread UNSAFE-style strings: FAIL wins over substring PASS", async () => {
    // A reply containing both words is unclear → that model abstains; the
    // other model's PASS decides.
    createMock
      .mockResolvedValueOnce(reply("PASS"))
      .mockResolvedValueOnce(reply("hmm, PASS or FAIL? unclear"));
    expect(await moderate("ambiguous")).toEqual({ ok: true });
  });

  it("still decides when one model errors (abstains)", async () => {
    createMock
      .mockResolvedValueOnce(reply("PASS"))
      .mockRejectedValueOnce(new Error("rate limited"));
    expect(await moderate("page")).toEqual({ ok: true });
  });

  it("throws when every model is undetermined", async () => {
    createMock.mockRejectedValue(new Error("all down"));
    await expect(moderate("page")).rejects.toThrow(/undetermined/i);
  });
});
