# kicks-js-proxy

Internal tool for a single sneaker shop: reads StockX pricing/product data from the
KicksDB API, lets an operator preview repricing changes, and produces a JSON file to
re-import into one WooCommerce store.

Next.js (App Router) · TypeScript · Tailwind + shadcn-style primitives · Drizzle/Postgres
· Redis (optional KicksDB cache) · Zod. **No `@tanstack/*`** (enforced in CI).

The store integration is **JSON round-trip**, not live REST: the operator exports a
WooCommerce model (`format: rp_cm_roundtrip`), uploads it here, previews repricing, and
downloads a patched model to re-import. Only `regular_price` is changed; SEO/GMC
attributes, descriptions, images and stock are preserved. The operator owns the actual
Woo import/export.

## Setup

```bash
npm ci
cp .env.example .env            # KicksDB key, DB/Redis URLs (Woo creds no longer needed)
docker compose up -d            # local Postgres + Redis (dev only)
npm run db:migrate              # apply migrations (creates all tables)
npm run dev                     # http://localhost:3000/preview
```

All secrets live in env (typed + Zod-validated in `src/lib/env.ts`); none are persisted.

## Flow

1. **Upload store snapshot** — paste/upload the WooCommerce round-trip JSON. It's
   validated and stored (single active snapshot).
2. **Preview** (`/preview`): fetch StockX by SKU (persistent catalog cache) or query →
   match each variant to a store variation **by EU size** → `buildPlan` → grouped,
   collapsible diff (update / create / noop / skip) with per-row + quick-select.
3. **Export** — download the re-import JSON: `regular_price` patched on the selected,
   matched variations; only changed products included; everything else preserved.

## Round-trip REST API

For automation, the same round-trip flow is exposed as REST routes that mirror
the WooCommerce `gh/v1` plugin shape. Optional Basic auth (`ROUNDTRIP_BASIC_USER`
/ `ROUNDTRIP_BASIC_PASS`) gates them; unset = open.

```bash
# 1. export the active snapshot as a round-trip file (?scope=searchable strips it
#    down to only the SKUs KicksDB can price — ~half the catalog never resolves)
curl -s "http://localhost:3000/api/gh/v1/roundtrip/export?scope=searchable" -o roundtrip.json

# 2. dry-run: reprice the file's searchable SKUs and report what would change
curl -s -H "Content-Type: application/json" \
  "http://localhost:3000/api/gh/v1/roundtrip/preview?mode=update_only" \
  --data-binary @roundtrip.json

# 3. commit: merge changes into the snapshot, get the lean re-import file back
curl -s -H "Content-Type: application/json" \
  "http://localhost:3000/api/gh/v1/roundtrip/apply?mode=update_only" \
  --data-binary @roundtrip.json
```

`mode` is one of `update_only` (reprice matched variations — safest, default),
`create_only` (add StockX sizes/products the store lacks), `upsert` (both), or
`replace` (upsert **and** drop store sizes StockX no longer lists). Non-searchable
SKUs are always left untouched and reported in `stats.strippedSkus`. `apply`
returns the changed-products-only re-import file in `output`; `preview` adds it
only with `&include=output`.

## Core

- `core/core-spine.ts`, `core/config.ts` — domain model, pricing engine
  (`computePrice`/`resolveEffectiveRule`), plan/diff (`buildPlan`), the `SourcePort` seam.
- `src/server/store-json/` — the Woo model schema, EU-size matching, and the price patch.

## Pricing config

Defaults in `src/server/config/defaults.ts` (general rule: 17% markup, 22% VAT, charm
`.99`, no delta cap). Edit markup / VAT / rounding / minAsks live from the **Pricing**
bar on `/preview` (saved to Postgres), or **Reset** it back to the defaults — no SQL.

## Scripts

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest (pricing/plan/match/patch core)
npm run guard:tanstack
npm run db:generate   # drizzle migration from schema
npm run build
```
