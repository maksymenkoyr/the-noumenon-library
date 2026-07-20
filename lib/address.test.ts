import { describe, expect, it } from "vitest";
import {
  GALLERY_MAX_LENGTH,
  PAGES,
  SHELVES,
  VOLUMES,
  WALLS,
  addressPath,
  formatAddress,
  nextAddress,
  normalizeAddress,
  randomAddress,
  type Address,
} from "./address";

// These tests lock normalizeAddress permanently: once pages are stored,
// any change in accepted/rejected addresses or canonical form orphans
// every existing page. Do not loosen without a migration plan.

const VALID = ["io-9", "3", "2", "17", "308"];

function addr(
  gallery: string,
  wall: number,
  shelf: number,
  volume: number,
  page: number,
): Address {
  return { gallery, wall, shelf, volume, page };
}

describe("normalizeAddress — accepts", () => {
  it("parses the canonical documented example", () => {
    expect(normalizeAddress(VALID)).toEqual(addr("io-9", 3, 2, 17, 308));
  });

  it("lower-cases the gallery token (the only transform)", () => {
    expect(normalizeAddress(["IO-9", "3", "2", "17", "308"])).toEqual(
      addr("io-9", 3, 2, 17, 308),
    );
    expect(normalizeAddress(["AbC", "1", "1", "1", "1"])?.gallery).toBe("abc");
  });

  it("accepts single-character galleries", () => {
    expect(normalizeAddress(["a", "1", "1", "1", "1"])?.gallery).toBe("a");
    expect(normalizeAddress(["7", "1", "1", "1", "1"])?.gallery).toBe("7");
  });

  it("accepts a max-length gallery", () => {
    const gallery = "a".repeat(GALLERY_MAX_LENGTH);
    expect(normalizeAddress([gallery, "1", "1", "1", "1"])?.gallery).toBe(
      gallery,
    );
  });

  it("accepts interior hyphens, including consecutive ones", () => {
    expect(normalizeAddress(["a-b", "1", "1", "1", "1"])?.gallery).toBe("a-b");
    expect(normalizeAddress(["a--b", "1", "1", "1", "1"])?.gallery).toBe(
      "a--b",
    );
    expect(normalizeAddress(["0-0", "1", "1", "1", "1"])?.gallery).toBe("0-0");
  });

  it("accepts every dimension at both range boundaries", () => {
    expect(normalizeAddress(["g", "1", "1", "1", "1"])).toEqual(
      addr("g", 1, 1, 1, 1),
    );
    expect(
      normalizeAddress(["g", `${WALLS}`, `${SHELVES}`, `${VOLUMES}`, `${PAGES}`]),
    ).toEqual(addr("g", WALLS, SHELVES, VOLUMES, PAGES));
  });
});

describe("normalizeAddress — rejects", () => {
  it("rejects wrong segment counts", () => {
    expect(normalizeAddress([])).toBeNull();
    expect(normalizeAddress(["io-9"])).toBeNull();
    expect(normalizeAddress(["io-9", "3", "2", "17"])).toBeNull();
    expect(normalizeAddress([...VALID, "1"])).toBeNull();
  });

  it("rejects an empty or oversized gallery", () => {
    expect(normalizeAddress(["", "1", "1", "1", "1"])).toBeNull();
    expect(
      normalizeAddress(["a".repeat(GALLERY_MAX_LENGTH + 1), "1", "1", "1", "1"]),
    ).toBeNull();
  });

  it("rejects gallery characters outside [a-z0-9-]", () => {
    for (const gallery of ["io.9", "io_9", "io 9", "io/9", "ío9", "io⁹", "i+9"]) {
      expect(normalizeAddress([gallery, "1", "1", "1", "1"])).toBeNull();
    }
  });

  it("rejects leading/trailing hyphens and a bare hyphen", () => {
    for (const gallery of ["-io9", "io9-", "-io9-", "-", "--"]) {
      expect(normalizeAddress([gallery, "1", "1", "1", "1"])).toBeNull();
    }
  });

  it("rejects non-canonical numeric segments (no aliasing)", () => {
    for (const wall of ["0", "03", "+3", "3.0", "3a", "a", "", " 3", "3 "]) {
      expect(normalizeAddress(["g", wall, "1", "1", "1"])).toBeNull();
    }
    expect(normalizeAddress(["g", "1", "1", "1", "0308"])).toBeNull();
  });

  it("rejects out-of-range dimensions — no clamping", () => {
    expect(normalizeAddress(["g", `${WALLS + 1}`, "1", "1", "1"])).toBeNull();
    expect(normalizeAddress(["g", "1", `${SHELVES + 1}`, "1", "1"])).toBeNull();
    expect(normalizeAddress(["g", "1", "1", `${VOLUMES + 1}`, "1"])).toBeNull();
    expect(normalizeAddress(["g", "1", "1", "1", `${PAGES + 1}`])).toBeNull();
    expect(normalizeAddress(["g", "1", "1", "1", "999"])).toBeNull();
  });
});

describe("formatAddress / addressPath", () => {
  it("round-trips the canonical example", () => {
    const parsed = normalizeAddress(VALID)!;
    expect(formatAddress(parsed)).toBe("io-9/3/2/17/308");
    expect(addressPath(parsed)).toBe("/io-9/3/2/17/308");
  });

  it("normalize ∘ format is the identity on canonical addresses", () => {
    const parsed = normalizeAddress(["IO-9", "3", "2", "17", "308"])!;
    expect(normalizeAddress(formatAddress(parsed).split("/"))).toEqual(parsed);
  });
});

describe("nextAddress", () => {
  it("increments the page within a volume", () => {
    expect(nextAddress(addr("g", 1, 1, 1, 1))).toEqual(addr("g", 1, 1, 1, 2));
    expect(nextAddress(addr("g", 2, 3, 4, 409))).toEqual(
      addr("g", 2, 3, 4, 410),
    );
  });

  it("rolls over page → volume → shelf → wall", () => {
    expect(nextAddress(addr("g", 1, 1, 1, PAGES))).toEqual(
      addr("g", 1, 1, 2, 1),
    );
    expect(nextAddress(addr("g", 1, 1, VOLUMES, PAGES))).toEqual(
      addr("g", 1, 2, 1, 1),
    );
    expect(nextAddress(addr("g", 1, SHELVES, VOLUMES, PAGES))).toEqual(
      addr("g", 2, 1, 1, 1),
    );
  });

  it("rolls over into the next gallery", () => {
    const last = addr("io-9", WALLS, SHELVES, VOLUMES, PAGES);
    expect(nextAddress(last)).toEqual(addr("io-a", 1, 1, 1, 1));
  });

  it("increments galleries as a mixed-radix counter", () => {
    const step = (gallery: string) =>
      nextAddress(addr(gallery, WALLS, SHELVES, VOLUMES, PAGES)).gallery;
    expect(step("a")).toBe("b");
    expect(step("9")).toBe("a");
    expect(step("az")).toBe("b0");
    expect(step("a-z")).toBe("a00");
    expect(step("a0z")).toBe("a10");
    expect(step("azz")).toBe("b-0");
  });

  it("grows gallery length on full carry", () => {
    const step = (gallery: string) =>
      nextAddress(addr(gallery, WALLS, SHELVES, VOLUMES, PAGES)).gallery;
    expect(step("z")).toBe("00");
    expect(step("zz")).toBe("0-0");
    expect(step("zzz")).toBe("0--0");
  });

  it("wraps the whole library at the very last address", () => {
    const last = addr(
      "z".repeat(GALLERY_MAX_LENGTH),
      WALLS,
      SHELVES,
      VOLUMES,
      PAGES,
    );
    expect(nextAddress(last)).toEqual(addr("0", 1, 1, 1, 1));
  });

  it("always yields a valid address (fuzz)", () => {
    for (let i = 0; i < 500; i++) {
      const next = nextAddress(randomAddress());
      expect(normalizeAddress(formatAddress(next).split("/"))).toEqual(next);
    }
  });
});

describe("randomAddress", () => {
  it("always yields an in-range address that round-trips (fuzz)", () => {
    for (let i = 0; i < 500; i++) {
      const a = randomAddress();
      expect(a.gallery.length).toBeGreaterThanOrEqual(1);
      expect(a.gallery.length).toBeLessThanOrEqual(GALLERY_MAX_LENGTH);
      expect(a.wall).toBeGreaterThanOrEqual(1);
      expect(a.wall).toBeLessThanOrEqual(WALLS);
      expect(a.shelf).toBeGreaterThanOrEqual(1);
      expect(a.shelf).toBeLessThanOrEqual(SHELVES);
      expect(a.volume).toBeGreaterThanOrEqual(1);
      expect(a.volume).toBeLessThanOrEqual(VOLUMES);
      expect(a.page).toBeGreaterThanOrEqual(1);
      expect(a.page).toBeLessThanOrEqual(PAGES);
      expect(normalizeAddress(formatAddress(a).split("/"))).toEqual(a);
    }
  });
});
