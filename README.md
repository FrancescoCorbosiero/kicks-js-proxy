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
