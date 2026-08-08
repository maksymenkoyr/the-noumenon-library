import { readFileSync } from "node:fs";
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
vi.mock("./monitor", () => ({ monitor: vi.fn() }));

import { closePool, query } from "./db";
import { parseTerms, pickTerm, termsForGallery } from "./gallerySeeds";
import { makeSeededRandom, volumeSeed } from "./seededRandom";

function completion(content: string) {
  return { choices: [{ message: { content } }], usage: { total_tokens: 0 } };
}

/** A plausible expansion — enough entries to clear the too-few-terms floor. */
const TERMS = [
  "bavaria", "roundel", "inline-six", "autobahn", "munich", "kidney grille",
  "chrome", "leather", "machine oil", "welding", "cold mornings", "sediment",
];

beforeAll(async () => {
  await query(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  createMock.mockReset();
  await query("TRUNCATE gallery_seeds");
  // schema.sql seeds the real generation pool, so pin it to one known row —
  // otherwise the weighted lottery decides which model the assertions expect
  // (same approach as lib/generate.test.ts).
  await query("TRUNCATE model_registry");
  await query(
    `INSERT INTO model_registry (slug, provider, task, enabled, weight, temperature, max_tokens)
     VALUES ('model-a', 'openrouter', 'generation', true, 10, 0.9, 1000)`,
  );
});

afterAll(async () => {
  await closePool();
});

describe("parseTerms", () => {
  it("strips the decoration models add to lists regardless of instructions", () => {
    const parsed = parseTerms("1. bavaria\n- roundel\n* autobahn\n2) munich.");
    expect(parsed).toEqual(["bavaria", "roundel", "autobahn", "munich"]);
  });

  it("drops blanks, duplicates, and anything sentence-length", () => {
    const long = "a".repeat(61);
    const parsed = parseTerms(`bavaria\n\nBavaria\n${long}\nroundel`);
    // Case-insensitive dedup: the same term twice would double its odds of
    // being drawn.
    expect(parsed).toEqual(["bavaria", "roundel"]);
  });

  it("drops text-types even though the prompt already forbids them", () => {
    // Observed for real: a probe run returned "manuscript", "scroll", "fable"
    // and "tale" despite the instruction. Seeding a page with "fable" is the
    // register label that got GENERATION_FORMS deleted (commit 6d613cc).
    const parsed = parseTerms("bavaria\nfable\nmanuscript\nTale\nsonnet\nroundel");
    expect(parsed).toEqual(["bavaria", "roundel"]);
  });

  it("caps the list however many the model actually returns", () => {
    // Asking for 50 is a request, not a constraint — one probe run came back
    // with 332, and the tail decayed into abstractions.
    const parsed = parseTerms(
      Array.from({ length: 400 }, (_, i) => `term-${i}`).join("\n"),
    );
    expect(parsed.length).toBeLessThanOrEqual(100);
    // The head of the list is the good part, so truncation keeps it.
    expect(parsed[0]).toBe("term-0");
  });
});

describe("termsForGallery", () => {
  it("mints terms on first use and stores them", async () => {
    createMock.mockResolvedValueOnce(completion(TERMS.join("\n")));
    const terms = await termsForGallery("bmw89");
    expect(terms).toEqual(TERMS);

    const rows = await query<{ terms: string[]; model: string }>(
      "SELECT terms, model FROM gallery_seeds WHERE gallery = $1",
      ["bmw89"],
    );
    expect(rows[0].terms).toEqual(TERMS);
    expect(rows[0].model).toBe("model-a");
  });

  it("never calls the model twice for a gallery that already has terms", async () => {
    createMock.mockResolvedValueOnce(completion(TERMS.join("\n")));
    await termsForGallery("amber");
    const terms = await termsForGallery("amber");
    expect(terms).toEqual(TERMS);
    // One row amortizes over a gallery's 262,400 pages — the second read must
    // be pure DB.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("never sends the address, only the gallery token", async () => {
    createMock.mockResolvedValueOnce(completion(TERMS.join("\n")));
    await termsForGallery("bmw89");
    const prompt = createMock.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("bmw89");
    expect(prompt).not.toMatch(/\d+\/\d+\/\d+\/\d+/);
  });

  it("asks for subjects, not kinds of writing", async () => {
    // The GENERATION_FORMS regression line (commit 6d613cc): a register label
    // is an imitation target and yields pastiche. A subject is not a style.
    createMock.mockResolvedValueOnce(completion(TERMS.join("\n")));
    await termsForGallery("bmw89");
    const prompt = createMock.mock.calls[0][0].messages[0].content;
    expect(prompt).toMatch(/never a kind of writing/i);
    expect(prompt).not.toMatch(/reads like|in the style of/i);
  });

  it("fails open when the model call throws, and stores nothing", async () => {
    createMock.mockRejectedValueOnce(new Error("provider down"));
    expect(await termsForGallery("down1")).toEqual([]);
    const rows = await query("SELECT 1 FROM gallery_seeds WHERE gallery = $1", ["down1"]);
    // Storing a failure would make the emptiness permanent — the page is
    // generated unseeded instead, and a later visit retries.
    expect(rows).toHaveLength(0);
  });

  it("treats a near-empty expansion as a failure, not as a quiet gallery", async () => {
    createMock.mockResolvedValueOnce(completion("bavaria\nroundel"));
    expect(await termsForGallery("thin1")).toEqual([]);
    const rows = await query("SELECT 1 FROM gallery_seeds WHERE gallery = $1", ["thin1"]);
    expect(rows).toHaveLength(0);
  });

  it("does not re-call the model for a gallery that just failed", async () => {
    // A page failing moderation re-runs chooseLevers twice more in the same
    // request; without the negative window that is three association calls for
    // one page.
    createMock.mockRejectedValueOnce(new Error("provider down"));
    await termsForGallery("down2");
    await termsForGallery("down2");
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("pickTerm", () => {
  it("returns undefined for a gallery with no terms", () => {
    expect(pickTerm([], makeSeededRandom("x"))).toBeUndefined();
  });

  it("gives every page of a volume the same term", () => {
    // The whole point of seeding on the volume: a shelf holds books, and a
    // book is about something.
    const first = pickTerm(TERMS, makeSeededRandom(volumeSeed("bmw89/3/2/17/1")));
    const middle = pickTerm(TERMS, makeSeededRandom(volumeSeed("bmw89/3/2/17/206")));
    const last = pickTerm(TERMS, makeSeededRandom(volumeSeed("bmw89/3/2/17/410")));
    expect(first).toBeDefined();
    expect(middle).toBe(first);
    expect(last).toBe(first);
  });

  it("lets neighbouring volumes diverge", () => {
    const drawn = new Set(
      Array.from({ length: 32 }, (_, i) =>
        pickTerm(TERMS, makeSeededRandom(volumeSeed(`bmw89/3/2/${i + 1}/1`))),
      ),
    );
    // Not a distribution assertion — just that the volume is genuinely part of
    // the seed rather than the gallery alone deciding everything.
    expect(drawn.size).toBeGreaterThan(1);
  });
});
