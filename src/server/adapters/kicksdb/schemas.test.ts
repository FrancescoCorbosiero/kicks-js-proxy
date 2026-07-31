import { describe, expect, it } from "vitest";
import { KicksPricesResponseSchema, KicksProductsResponseSchema } from "./schemas";

/**
 * KicksDB once shipped a delivery `type` outside our enum and the strict
 * schema failed the WHOLE bulk response — taking the store preview down with
 * it. Unknown tiers must parse and be dropped, never explode.
 */
describe("tolerant delivery types", () => {
  it("bulk prices: unknown type parses and the row is droppable (type undefined)", () => {
    const parsed = KicksPricesResponseSchema.parse({
      data: [
        {
          product_id: "p1",
          sku: "AAA-111",
          variants: [
            { id: "v1", size: "42", size_type: "eu", price: 100, asks: 3, type: "standard" },
            { id: "v1", size: "42", size_type: "eu", price: 90, asks: 1, type: "warehouse_flash" },
            { id: "v2", size: "43", size_type: "eu", price: 120, asks: 2, type: null },
          ],
        },
      ],
    });
    const variants = parsed.data[0].variants!;
    expect(variants[0].type).toBe("standard");
    expect(variants[1].type).toBeUndefined(); // unknown tier → dropped by the mapper
    expect(variants[2].type).toBeUndefined();
  });

  it("products: unknown-tier price entries are dropped, known ones kept", () => {
    const parsed = KicksProductsResponseSchema.parse({
      data: [
        {
          id: "p1",
          sku: "AAA-111",
          title: "T",
          brand: "B",
          image: null,
          variants: [
            {
              id: "v1",
              size: "42",
              size_type: "eu",
              prices: [
                { price: 100, asks: 3, type: "standard" },
                { price: 95, asks: 1, type: "hyperspeed" },
              ],
            },
            {
              id: "v2",
              size: "43",
              size_type: "eu",
              prices: [{ price: 80, asks: 2, type: "hyperspeed" }],
              lowest_ask: 80,
              total_asks: 2,
            },
          ],
        },
      ],
    });
    const [v1, v2] = parsed.data[0].variants!;
    expect(v1.prices).toEqual([{ price: 100, asks: 3, type: "standard" }]);
    // All entries unknown → undefined, so the mapper falls back to lowest_ask.
    expect(v2.prices).toBeUndefined();
  });
});
