import { describe, expect, it } from "vitest";
import { parsePressedEntry, pressedKey, PRESSED_PREFIX } from "./pressed";

describe("pressedKey", () => {
  it("prefixes the canonical address", () => {
    expect(pressedKey("io-9/3/2/17/308")).toBe(
      `${PRESSED_PREFIX}io-9/3/2/17/308`,
    );
  });
});

describe("parsePressedEntry", () => {
  it("round-trips a timestamped press mark", () => {
    const now = Date.now();
    expect(parsePressedEntry(pressedKey("io-9/3/2/17/308"), String(now))).toEqual(
      { address: "io-9/3/2/17/308", pressedAt: now },
    );
  });

  it("treats a legacy \"1\" mark as pressed, sorting older than real marks", () => {
    const entry = parsePressedEntry(pressedKey("io-9/3/2/17/308"), "1");
    expect(entry?.address).toBe("io-9/3/2/17/308");
    expect(entry!.pressedAt).toBeLessThan(Date.now() - 1000);
  });

  it("treats a non-numeric value as pressed at 0", () => {
    expect(parsePressedEntry(pressedKey("io-9/3/2/17/308"), "yes")).toEqual({
      address: "io-9/3/2/17/308",
      pressedAt: 0,
    });
  });

  it("ignores foreign localStorage keys", () => {
    expect(parsePressedEntry("noumenon:arrived-via", "next")).toBeNull();
    expect(parsePressedEntry("theme", "dark")).toBeNull();
  });

  it("ignores keys whose suffix is not a canonical address", () => {
    expect(parsePressedEntry(`${PRESSED_PREFIX}not-an-address`, "1")).toBeNull();
    expect(parsePressedEntry(`${PRESSED_PREFIX}io-9/3/2/17/0`, "1")).toBeNull();
    expect(parsePressedEntry(`${PRESSED_PREFIX}IO-9/03/2/17/308`, "1")).toBeNull();
  });

  it("ignores a null value", () => {
    expect(parsePressedEntry(pressedKey("io-9/3/2/17/308"), null)).toBeNull();
  });
});
