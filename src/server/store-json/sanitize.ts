import type { StoreModel, StoreProductModel, StoreVariation } from "./model";
import { normSize, variationEuSize, variationSizeLabel, preferStoreVariation } from "./match";

/**
 * Two automatic fixes for the WooCommerce round-trip model, both known to cause
 * the "variation silently not shown on the product page" glitch:
 *
 *  1. Ghost variations — a variation with stock_quantity === 0 is returned by the
 *     JSON/REST APIs but never rendered on the storefront. They pile up and
 *     conflict with the live ones, so we drop them.
 *
 *  2. Duplicate variations — the corrupt catalog carries two variations for one
 *     physical size: a clean web-app entry ("IE7002-EU36 2/3", pa_taglia "36 2/3")
 *     and a stale snapshot row ("IE7002-3623", pa_taglia "36-2-3"). Woo hides a
 *     size that has two conflicting variations, so we collapse each size to a
 *     single best variation — KicksDB-backed first, then the clean web-app row
 *     over the corrupt snapshot one — and drop the rest.
 *
 *  3. Misaligned pa_taglia — Woo hides a variation whose `pa_taglia` value does
 *     not line up with the sizes actually present. We realign every surviving
 *     variation's `attribute_pa_taglia` to its true, human-readable size label
 *     (from pa_taglia, falling back to the SKU suffix) and, when the parent
 *     product carries a recognizable `pa_taglia` attribute, realign its option
 *     list to exactly the surviving sizes.
 *
 * Pure and non-mutating: it clones the model, keeps only the products it actually
 * changed (so the re-import touches nothing else), and preserves every other
 * field (SEO, GMC, images, stock, …).
 */

export interface SanitizeReport {
  productsScanned: number;
  variationsScanned: number;
  productsChanged: number;
  ghostsRemoved: number; // zero-stock variations dropped (NOT on KicksDB)
  stockSynthesized: number; // zero-stock variations kept + made available (on KicksDB)
  duplicatesRemoved: number; // stale twin variations dropped (same size, corrupt row)
  taglieRealigned: number; // variation pa_taglia values corrected
  parentAttributesRealigned: number; // parent products whose pa_taglia options were realigned
}

export interface SanitizeOutcome {
  output: StoreModel; // only changed products, everything else preserved
  report: SanitizeReport;
}

/** Coerce a stock field (number or numeric string) to a number, else null. */
function toNumber(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number.parseFloat(x);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** A variation is a ghost when its managed stock quantity is exactly zero. */
function isGhost(vrt: StoreVariation): boolean {
  return toNumber(vrt.stock_quantity) === 0;
}

/** The current pa_taglia value on a variation, as a plain string (or null). */
function currentTaglia(vrt: StoreVariation): string | null {
  const raw = vrt.attributes?.["attribute_pa_taglia"];
  return raw == null ? null : String(raw);
}

/**
 * Realign a parent product's `pa_taglia` attribute options to `sizes`. Handles
 * the two shapes we've seen — an array of attribute objects, or an object keyed
 * by attribute slug — and only rewrites an `options`/`values` list that already
 * exists. Returns true if anything changed. Never throws on an unknown shape.
 */
function realignParentTaglia(product: StoreProductModel, sizes: string[]): boolean {
  const attrs = (product as { attributes?: unknown }).attributes;
  const isTaglia = (name: unknown) => String(name ?? "").toLowerCase().includes("taglia");

  const applyTo = (attr: Record<string, unknown>): boolean => {
    let changed = false;
    for (const field of ["options", "values"] as const) {
      const list = attr[field];
      if (Array.isArray(list)) {
        const next = sizes;
        const same = list.length === next.length && list.every((x, i) => String(x) === next[i]);
        if (!same) {
          attr[field] = next;
          changed = true;
        }
      }
    }
    return changed;
  };

  if (Array.isArray(attrs)) {
    let changed = false;
    for (const attr of attrs) {
      if (attr && typeof attr === "object") {
        const a = attr as Record<string, unknown>;
        if (isTaglia(a.name) || isTaglia(a.slug)) changed = applyTo(a) || changed;
      }
    }
    return changed;
  }

  if (attrs && typeof attrs === "object") {
    let changed = false;
    for (const [key, val] of Object.entries(attrs as Record<string, unknown>)) {
      if (!isTaglia(key)) continue;
      if (Array.isArray(val)) {
        const same = val.length === sizes.length && val.every((x, i) => String(x) === sizes[i]);
        if (!same) {
          (attrs as Record<string, unknown>)[key] = sizes;
          changed = true;
        }
      } else if (val && typeof val === "object") {
        changed = applyTo(val as Record<string, unknown>) || changed;
      }
    }
    return changed;
  }

  return false;
}

/** Sort human size labels by true numeric value ("36" < "36 2/3" < "37 1/3"),
 *  via normSize so mixed fractions order correctly; stable on unparseable ties. */
function sortSizeLabels(labels: string[]): string[] {
  return [...labels].sort((a, b) => {
    const na = Number.parseFloat(normSize(a) ?? "");
    const nb = Number.parseFloat(normSize(b) ?? "");
    if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
    return na - nb;
  });
}

/**
 * Order two same-size variations, best first (negative => `a` wins): a variation
 * backed by KicksDB (`keepAvailable`) is authoritative and wins; otherwise defer
 * to preferStoreVariation (clean web-app row over corrupt snapshot, then newer id).
 */
function betterVariation(
  parentSku: string,
  a: StoreVariation,
  b: StoreVariation,
  keepAvailable: ReadonlySet<number>,
): number {
  const kicks = (keepAvailable.has(b.id) ? 1 : 0) - (keepAvailable.has(a.id) ? 1 : 0);
  if (kicks !== 0) return kicks; // on KicksDB first
  return preferStoreVariation(parentSku, a, b);
}

/**
 * Collapse variations that resolve to the SAME physical EU size down to a single
 * best one (betterVariation), dropping the rest in place. Variations with no
 * resolvable size are never touched. Returns how many were dropped.
 */
function dedupeBySize(
  product: StoreProductModel,
  keepAvailable: ReadonlySet<number>,
): number {
  const groups = new Map<string, StoreVariation[]>();
  for (const vrt of product.variations) {
    const key = variationEuSize(product.sku, vrt);
    if (!key) continue; // unknown size — leave it alone
    const list = groups.get(key);
    if (list) list.push(vrt);
    else groups.set(key, [vrt]);
  }

  const drop = new Set<number>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const best = list.reduce((a, b) => (betterVariation(product.sku, a, b, keepAvailable) <= 0 ? a : b));
    for (const vrt of list) if (vrt !== best) drop.add(vrt.id);
  }
  if (drop.size === 0) return 0;
  product.variations = product.variations.filter((v) => !drop.has(v.id));
  return drop.size;
}

/** The counts a single-product sanitize produced. */
export interface ProductSanitizeResult {
  ghostsRemoved: number;
  stockSynthesized: number;
  duplicatesRemoved: number;
  taglieRealigned: number;
  parentRealigned: boolean;
  changed: boolean;
}

/** Make a zero-stock variation available without a fake count: KicksDB has no
 *  stock, so if StockX carries the size we sell it on demand. */
function makeAvailable(vrt: StoreVariation): void {
  vrt.stock_status = "instock";
  vrt.manage_stock = false;
}

/**
 * Sanitize ONE product in place (mutates it). A zero-stock variation is a GHOST
 * only when it is NOT on KicksDB (`keepAvailable` — the store variation ids
 * present on KicksDB) — those are dropped. A zero-stock variation that IS on
 * KicksDB is KEPT and made available (StockX carries the size), never cut. Then
 * collapse duplicate variations for the same size (KicksDB > clean web-app entry >
 * corrupt snapshot), and realign each survivor's pa_taglia and the parent option
 * list. Shared by the standalone sanitize and the unified reprice+sanitize export.
 */
export function sanitizeProduct(
  product: StoreProductModel,
  keepAvailable: ReadonlySet<number> = new Set(),
): ProductSanitizeResult {
  // 1. Zero-stock variations: drop true ghosts, keep + make-available KicksDB ones.
  const kept: StoreVariation[] = [];
  let ghostsRemoved = 0;
  let stockSynthesized = 0;
  for (const vrt of product.variations) {
    if (isGhost(vrt)) {
      if (keepAvailable.has(vrt.id)) {
        makeAvailable(vrt);
        stockSynthesized += 1;
        kept.push(vrt); // on KicksDB -> stays, now visible
      } else {
        ghostsRemoved += 1; // truly dead -> drop
      }
    } else {
      kept.push(vrt);
    }
  }
  if (ghostsRemoved > 0) product.variations = kept;

  // 2. Collapse duplicate variations for the same physical size.
  const duplicatesRemoved = dedupeBySize(product, keepAvailable);

  // 3. Realign each surviving variation's pa_taglia to its human size label.
  const labels: string[] = [];
  let taglieRealigned = 0;
  for (const vrt of product.variations) {
    const desired = variationSizeLabel(product.sku, vrt); // pa_taglia first, then SKU suffix
    if (!desired) continue;
    labels.push(desired);
    if (currentTaglia(vrt) !== desired) {
      vrt.attributes = { ...(vrt.attributes ?? {}), attribute_pa_taglia: desired };
      taglieRealigned += 1;
    }
  }

  // 4. Realign the parent product's pa_taglia option list to the surviving sizes.
  const unique = sortSizeLabels([...new Set(labels)]);
  const parentRealigned = unique.length > 0 && realignParentTaglia(product, unique);

  return {
    ghostsRemoved,
    stockSynthesized,
    duplicatesRemoved,
    taglieRealigned,
    parentRealigned,
    changed:
      ghostsRemoved > 0 ||
      stockSynthesized > 0 ||
      duplicatesRemoved > 0 ||
      taglieRealigned > 0 ||
      parentRealigned,
  };
}

export function sanitizeModel(model: StoreModel): SanitizeOutcome {
  const clone: StoreModel = structuredClone(model);
  const report: SanitizeReport = {
    productsScanned: clone.products.length,
    variationsScanned: 0,
    productsChanged: 0,
    ghostsRemoved: 0,
    stockSynthesized: 0,
    duplicatesRemoved: 0,
    taglieRealigned: 0,
    parentAttributesRealigned: 0,
  };
  const changed = new Set<number>();

  for (const product of clone.products) {
    report.variationsScanned += product.variations.length;
    const r = sanitizeProduct(product);
    report.ghostsRemoved += r.ghostsRemoved;
    report.stockSynthesized += r.stockSynthesized;
    report.duplicatesRemoved += r.duplicatesRemoved;
    report.taglieRealigned += r.taglieRealigned;
    if (r.parentRealigned) report.parentAttributesRealigned += 1;
    if (r.changed) changed.add(product.id);
  }

  clone.products = clone.products.filter((p) => changed.has(p.id));
  if (typeof clone.product_count === "number") clone.product_count = clone.products.length;
  report.productsChanged = changed.size;

  return { output: clone, report };
}
