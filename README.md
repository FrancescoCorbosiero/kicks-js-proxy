# kicks-js-proxy

Internal tool for a single sneaker shop, built around one core domain: an
**ever-increasing catalog** of StockX products (via the KicksDB API). The
operator explores the catalog, locks manual prices, and syncs the WooCommerce
store **live over REST** — pull store state, preview a per-variant repricing
plan, apply the selected changes (dry-run first).

Next.js (App Router) · TypeScript · Tailwind + shadcn-style primitives · Drizzle/Postgres
· Redis (optional KicksDB cache) · Zod. **No `@tanstack/*`** (enforced in CI).

## Setup

```bash
npm ci
cp .env.example .env            # KicksDB key, Woo REST creds, DB/Redis URLs
docker compose up -d            # local Postgres + Redis (dev only)
npm run db:migrate              # apply migrations (creates all tables)
npm run dev                     # http://localhost:3000/catalog
```

All secrets live in env (typed + Zod-validated in `src/lib/env.ts`); none are persisted.

## The catalog (core domain)

`catalog_products` (`src/server/catalog/`) is unique by `(market, sku)` and
**append-only**: a SKU is added only after a `GET /stockx/products` lookup
returns a matching product (HTTP 200), so every entry is guaranteed fetchable
on KicksDB — and it never leaves. Stale entries are re-priced (TTL), never
removed. Every route feeds it: syncs, imports, previews.

Discovery columns (`image`, `min_ask`, `variant_count`, `added_at`) are
denormalized from the stored product at upsert time, so the grid
filters/sorts/paginates in SQL.

## Tabs

- **Catalog** (`/catalog`) — discovery: brand sidebar with counts, debounced
  search, freshness/price filters, six sorts, paged grid. All state in the URL.
  Clicking a card opens the **product drawer** (`?product=<sku>`; full-screen
  sheet on mobile): per-size asks + computed proposed prices, **re-sync from
  KicksDB**, per-size **manual price locks** and the per-product **sale rule**
  (both via `store_overrides`, keyed by SKU/EU size — snapshot-independent, so
  the sync honors them automatically).
- **Sync** (`/sync`) — the main workflow, all REST:
  1. **Pull**: walk the Woo REST API (`products` + variations) into the active
     store snapshot (`source: "rest"`). Cursor-driven and resumable
     (`store_pull_runs` + staging), sized for thousands of products, with live
     progress and cancel.
  2. **Preview**: the plan engine (`buildPlan`) matches StockX variants to Woo
     variations GTIN-first then by EU size, prices them through the scoped
     rules, and shows the per-variant diff (update / create / noop / skip).
  3. **Apply**: selected `update` rows are written back via
     `products/{id}/variations/batch` — **dry-run first** (live apply unlocks
     only after a dry run of the same selection). Every run lands in
     `apply_audit`; recent history shows on the tab.
- **Import** (`/import`) — manual textarea or CSV/TXT/TSV upload. SKUs are
  extracted, chunked, GET-verified and upserted through the same pipeline;
  each operator action is one `ingestion_runs` row (added / known / rejected).
- **Feeds** (`/feeds`) — the ingestion-source registry. Built-in feed:
  **KicksDB refresh**, which re-prices the stalest entries via the bulk
  endpoint (50 SKUs/call), merging fresh offers onto stored products. External
  supplier feeds plug in beside it (same pipeline, same history) — planned.
- *(hidden)* `/preview` — the legacy **file round-trip** flow (upload a Woo
  export, preview, download a patched re-import JSON with sanitize folded in).
  Fully functional, just unlinked — the fallback if REST must be reversed.
  Sanitize (ghost/duplicate variation cleanup, `pa_taglia` realignment) lives
  only here for now: deleting variations over live REST stays out of scope.

## Scheduled runs

Two authenticated cron endpoints (set `CRON_SECRET`, then hit them from any
scheduler):

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/pull-store       # full Woo pull
curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://host/api/cron/refresh-catalog  # re-price stale entries
```

## Core

- `core/core-spine.ts`, `core/config.ts` — domain model, pricing engine
  (`computePrice`/`resolveEffectiveRule`), plan/diff (`buildPlan`), the
  `SourcePort` seam, and the `WooStoreAdapter` skeleton behind the REST apply.
- `src/server/woo/` — the live Woo REST client, the resumable pull, the
  audited apply.
- `src/server/store-json/` — the store-state model (one shape, two transports:
  REST pull or file upload), EU-size matching, and the file-export patch path.

## Pricing config

Defaults in `src/server/config/defaults.ts` (general rule: 17% markup, 22% VAT,
charm `.99`, no delta cap). Edit markup / VAT / rounding / minAsks live from the
**Pricing** bar on `/preview` (saved to Postgres), or **Reset** to defaults.
Precedence for any variant price: **manual lock > sale rule > computed price**.

## Caching

Two independent best-effort layers (an outage degrades to a live fetch, never a
hard failure): the Redis TTL cache (`src/server/cache/`) for query results, and
the persistent catalog itself — the smart cache in front of every SKU lookup.

## Scripts

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest (pricing/plan/match/patch core)
npm run guard:tanstack
npm run db:generate   # drizzle migration from schema
npm run build
```
