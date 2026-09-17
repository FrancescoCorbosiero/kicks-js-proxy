import { describe, it, expect } from "vitest";
import { countOf, rowsOf } from "./rows";

describe("rowsOf — the shape a raw query really returns", () => {
  it("reads pg's QueryResult, which is an object and not an array", () => {
    // The shape that made every raw count in this codebase return zero.
    expect(rowsOf({ rows: [{ n: 3 }], rowCount: 1, command: "SELECT" })).toEqual([{ n: 3 }]);
  });

  it("still reads a driver that hands back a plain array", () => {
    expect(rowsOf([{ n: 3 }])).toEqual([{ n: 3 }]);
  });

  it("is empty for anything else, never throwing on a caller's behalf", () => {
    expect(rowsOf(null)).toEqual([]);
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf({})).toEqual([]);
    expect(rowsOf({ rows: null })).toEqual([]);
  });
});

describe("countOf", () => {
  it("reads a count out of a QueryResult", () => {
    expect(countOf({ rows: [{ n: 17000 }] })).toBe(17000);
  });

  it("reads a bigint count, which pg returns as a string", () => {
    expect(countOf({ rows: [{ n: "17000" }] })).toBe(17000);
  });

  it("is zero when there is genuinely nothing", () => {
    expect(countOf({ rows: [] })).toBe(0);
    expect(countOf({ rows: [{ n: null }] })).toBe(0);
    expect(countOf(null)).toBe(0);
  });
});
