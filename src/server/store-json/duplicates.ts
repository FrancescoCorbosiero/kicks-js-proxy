import { skuKey } from "@/lib/skus";
import { hasCleanSkuSize, managedStock, variationEuSize } from "./match";
import type { StoreModel, StoreProductModel } from "./model";

/**
 * Duplicate parent products: several published Woo products sharing one SKU
 * (a known artifact of the old snapshot import running next to manual data
 * entry). The sync tolerates them — it matches the best one — but on the
 * storefront they confuse customers and split stock, so the report surfaces
 * them and lets the operator move the redundant ones to the WordPress trash.
 */

export interface DupProduct {
  id: number;
  name: string | null;
  variationCount: number;
  /** Distinct recognized EU size keys carried by this product. */
  sizes: string[];
  /** Sum of managed stock across variations (unmanaged counts 0). */
  totalStock: number;
}

export interface DupEntry extends DupProduct {
  /** Removing loses nothing: every size also exists on the keeper. */
  safe: boolean;
  /** Sizes only this duplicate carries — why it is NOT safe. */
  missingSizes: string[];
}

export interface DuplicateGroup {
  sku: string; // canonical key
  keeper: DupProduct;
  duplicates: DupEntry[];
}

function describeProduct(p: StoreProductModel): DupProduct & { cleanSku: boolean } {
  const sizes = new Set<string>();
  let totalStock = 0;
  let cleanSku = false;
  for (const v of p.variations) {
    const eu = variationEuSize(p.sku, v);
    if (eu) sizes.add(eu);
    totalStock += managedStock(v) ?? 0;
    if (hasCleanSkuSize(p.sku, v)) cleanSku = true;
  }
  return {
    id: p.id,
    name: p.name ?? null,
    variationCount: p.variations.length,
    sizes: [...sizes].sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
    totalStock,
    cleanSku,
  };
}

/** Keeper preference: most size coverage, then clean SKU encoding, then newest. */
function keeperScore(a: ReturnType<typeof describeProduct>, b: ReturnType<typeof describeProduct>): number {
  if (a.sizes.length !== b.sizes.length) return b.sizes.length - a.sizes.length;
  if (a.cleanSku !== b.cleanSku) return a.cleanSku ? -1 : 1;
  return b.id - a.id;
}

/** All duplicate-SKU groups in the snapshot, keeper first, sorted by SKU. */
export function findDuplicateGroups(model: StoreModel): DuplicateGroup[] {
  const bySku = new Map<string, StoreProductModel[]>();
  for (const p of model.products) {
    if (!p.sku || !p.sku.trim()) continue;
    const key = skuKey(p.sku);
    const list = bySku.get(key) ?? [];
    list.push(p);
    bySku.set(key, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const [sku, products] of bySku) {
    if (products.length < 2) continue;
    const described = products.map(describeProduct).sort(keeperScore);
    const [keeperFull, ...rest] = described;
    const keeperSizes = new Set(keeperFull.sizes);
    const { cleanSku: _k, ...keeper } = keeperFull;

    groups.push({
      sku,
      keeper,
      duplicates: rest.map((d) => {
        const missingSizes = d.sizes.filter((s) => !keeperSizes.has(s));
        const { cleanSku: _d, ...info } = d;
        return { ...info, safe: missingSizes.length === 0, missingSizes };
      }),
    });
  }
  return groups.sort((a, b) => a.sku.localeCompare(b.sku));
}

/**
 * True when `productId` is listed as a SAFE duplicate (never the keeper) in
 * the given snapshot — the server-side gate every removal goes through.
 */
export function isSafeDuplicate(model: StoreModel, productId: number): boolean {
  return findDuplicateGroups(model).some((g) =>
    g.duplicates.some((d) => d.id === productId && d.safe),
  );
}
