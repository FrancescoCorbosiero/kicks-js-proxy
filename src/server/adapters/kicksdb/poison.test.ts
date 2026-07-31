import { describe, it, expect } from "vitest";
import { isPoisonedDataError } from "./poison";

/** The exact failure observed in production: KicksDB's Go code dies on a
 *  product whose sell_faster is negative, 500ing the whole batch call. */
const OBSERVED_BODY =
  '{"$schema":"https://api.kicks.dev/schemas/ErrorModel.json","title":"Internal Server Error",' +
  '"status":500,"detail":"unexpected error occurred","errors":[{"message":"json: cannot unmarshal ' +
  'number -5 into Go struct field StockXPriceVariant.Prices.variants.sell_faster of type uint32"}]}';

const httpError = (status: number | undefined, body?: string) =>
  Object.assign(new Error(`HTTP ${status}: ${body ?? ""}`), { status, body });

describe("isPoisonedDataError", () => {
  it("matches the observed sell_faster unmarshal 500", () => {
    expect(isPoisonedDataError(httpError(500, OBSERVED_BODY))).toBe(true);
  });

  it("matches via message when the body was not captured", () => {
    const e = Object.assign(new Error("HTTP 500: json: cannot unmarshal number -4 …"), {
      status: 500,
    });
    expect(isPoisonedDataError(e)).toBe(true);
  });

  it("a generic 500 is NOT poison — it must still read as an outage", () => {
    expect(isPoisonedDataError(httpError(500, "Internal Server Error"))).toBe(false);
  });

  it("gateway errors and rate limits are not poison", () => {
    expect(isPoisonedDataError(httpError(502, "Bad Gateway"))).toBe(false);
    expect(isPoisonedDataError(httpError(429, "Too Many Requests"))).toBe(false);
  });

  it("network failures (no status) are not poison", () => {
    expect(isPoisonedDataError(httpError(undefined))).toBe(false);
    expect(isPoisonedDataError(new Error("fetch failed"))).toBe(false);
    expect(isPoisonedDataError(null)).toBe(false);
  });
});
