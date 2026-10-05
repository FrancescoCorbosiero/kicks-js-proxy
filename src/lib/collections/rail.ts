import type { RailSummary } from "@/lib/vetrina/types";

/**
 * The one category a homepage rail shows, when it shows exactly one product
 * category — the only kind of rail an automatic category can fill. A brand
 * rail, or one listing several categories, answers null.
 */
export function railCategory(rail: Pick<RailSummary, "taxonomy" | "terms">): number | null {
  return rail.taxonomy === "product_cat" && rail.terms.length === 1 ? rail.terms[0].id : null;
}
