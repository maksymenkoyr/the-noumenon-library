import { describe, expect, it } from "vitest";
import { runs } from "./pixelArt";

describe("runs", () => {
  it("returns nothing for an empty frame", () => {
    expect(runs([])).toEqual([]);
  });

  it("returns nothing for an all-unlit row", () => {
    expect(runs(["...."])).toEqual([]);
  });

  it("merges a fully lit row into one run", () => {
    expect(runs(["####"])).toEqual([{ x: 0, y: 0, w: 4 }]);
  });

  it("finds a run starting at the left edge", () => {
    expect(runs(["#.."])).toEqual([{ x: 0, y: 0, w: 1 }]);
  });

  it("finds a run ending at the right edge", () => {
    expect(runs(["..#"])).toEqual([{ x: 2, y: 0, w: 1 }]);
  });

  it("splits multiple runs within one row", () => {
    expect(runs([".#.##."])).toEqual([
      { x: 1, y: 0, w: 1 },
      { x: 3, y: 0, w: 2 },
    ]);
  });

  it("assigns the row index as y across multiple rows", () => {
    expect(runs(["#.", ".#"])).toEqual([
      { x: 0, y: 0, w: 1 },
      { x: 1, y: 1, w: 1 },
    ]);
  });

  it("handles ragged row lengths", () => {
    expect(runs(["#####", "##"])).toEqual([
      { x: 0, y: 0, w: 5 },
      { x: 0, y: 1, w: 2 },
    ]);
  });

  it("treats any non-# character as unlit", () => {
    expect(runs([" .x#"])).toEqual([{ x: 3, y: 0, w: 1 }]);
  });
});
