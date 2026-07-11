# Producer contract — `rp_cm_roundtrip` output for the Hive Commerce importer

This repo **produces** the product JSON (`format: rp_cm_roundtrip`, v1). The
WooCommerce importer ("Hive Commerce") **ingests** it. This file states what our
output guarantees, so the importer's `sync` mode can rely on it. Pipeline:

> our file → **Bulk JSON** import tab → **`sync`** mode

`sync` treats each product's `variations[]` as the desired live set and hides
(0 stock + disabled, reversible) any existing variation whose SKU is absent.
Our output is designed to make that safe.

## Guarantees

1. **Full per-product snapshots.** Every product we emit carries its **complete**
   variation set — we never emit "only the changed sizes". The only variations
   ever absent are ones we deliberately drop (§3). We emit a *subset of products*
   (only changed ones); `sync` leaves unsent products untouched, which is correct.
   *Inherited precondition:* completeness comes from the uploaded WooCommerce
   export. Full export in → full snapshot out. A partial upload would round-trip
   partial — always upload a full store export.

2. **SKUs are pass-through and stable.** We never generate or modify a variation
   `sku`. We match StockX→Woo by EU size/GTIN and patch by Woo variation **id**;
   the `sku` string is emitted byte-for-byte from your export. WooCommerce is the
   SKU authority; per-size stability holds because we cannot touch it.

3. **Removals happen by omission, and only for true ghosts.** We drop a variation
   from `variations[]` **only** when it is `stock_quantity === 0` **and** not
   sourceable on StockX/KicksDB. In-stock sizes and 0-stock sizes StockX can still
   source are always kept (the latter flipped to `stock_status: instock`,
   `manage_stock: false`). So the omitted set == the set you should hide. We rely
   on your **hide (not delete)** + auto-re-enable-on-reappearance.

4. **`attributes.pa_taglia.options` always matches the emitted variations.** Every
   product we emit is realigned so its size-attribute option list equals the sizes
   of its `variations[]` (`alignParentOptions`), including on reprice-only exports.
   Your option-*replace* on variable update therefore never drifts the dropdown.

5. **Prices are plain decimal strings.** `regular_price` / `sale_price` are
   `Number.toFixed(2)` strings (e.g. `"134.99"`) — dot decimal, 2 places, no
   currency symbol or separators. We emit **no** currency field (store currency
   governs; market is EUR/IT). `format` and `version` pass through verbatim.

## Out of scope (unassigned)

- **Whole-product retirement.** We have no "retire" signal and never hide whole
  products; we just stop emitting unchanged ones. Feed-absence → retire, if wanted,
  is a separate step neither side does today.
- **Empty-SKU variations.** A variation with no SKU can't be tracked/hidden by the
  importer, and dropping it from our payload is therefore a no-op on import. These
  are an operator data-quality issue.

## Fields we read / write

We preserve every field in the uploaded model (loose round-trip). We only ever
**write**: variation `regular_price`, `global_unique_id` (GMC GTIN),
`attribute_pa_taglia`, and — for made-available sizes — `stock_status` +
`manage_stock`; parent `pa_taglia` options; and we drop true-ghost variations.
Everything else (SEO/Rank Math, categories, images, descriptions, other stock)
round-trips untouched.

## Source of truth

- `src/server/store-json/patch.ts` — `buildReimport` (sanitize-then-reprice, one file).
- `src/server/store-json/sanitize.ts` — ghost rule, make-available, `alignParentOptions`.
- `src/server/actions/export.ts` — the export action + summary.
