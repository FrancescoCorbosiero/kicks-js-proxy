# Catalog-Centric Redesign — Audit & Design Brainstorm

Status: **brainstorm / proposal** (nothing here is implemented yet).
Reference inspiration: [`FrancescoCorbosiero/scs-b2b`](https://github.com/FrancescoCorbosiero/scs-b2b) —
a feed-driven B2B catalog whose discovery UX and ingestion pipeline we borrow from,
while inverting its "read-only products" axis into product CRUD.

---

## 1. Audit — where the codebase stands today

### 1.1 What is solid (keep)

- **Hexagonal core.** `core/core-spine.ts` + `core/config.ts` are framework-free:
  normalized `SourceProduct`/`SourceVariant` model, data-driven scoped pricing rules
  (`resolveEffectiveRule` → `computePrice`), plan/diff engine (`buildPlan`), and the
  `SourcePort` seam. This is exactly the foundation a catalog-centric platform needs.
- **The catalog table already exists and is the strategic asset.**
  `catalog_products` (`src/server/db/schema.ts:89`) is ever-increasing, unique by
  `(market, sku)`, GET-verified (every SKU is guaranteed fetchable on KicksDB), and
  stores the full `SourceProduct` jsonb. Both preview paths feed it
  (`resolveSkusViaCatalog`, `growCatalogFromSkus` in `src/server/catalog/service.ts`).
- **Overrides are already snapshot-independent.** `src/server/overrides/` keys manual
  price locks and sale rules by stable `parentSku::euSize` identities — not Woo row
  ids. This means product-level CRUD (patch prices) can be built on the catalog *now*,
  and the reprice/export flow picks the same overrides up automatically. Precedence
  is fixed: **manual lock > sale rule > computed price**.
- **Woo JSON round-trip discipline.** `src/server/store-json/model.ts` parses loosely
  and returns the raw object so unknown fields round-trip untouched; sanitize + reprice
  are folded into one export (`buildReimport`). This stays as-is: it is the Woo
  *integration*, no longer the center of the app.

### 1.2 The core problem: the file is the center, the catalog is a cache

Today's mental model (README, module names, UI) is:

> upload snapshot file → preview against it → export patched file

- The **only** real screen is `/preview` — a 668-line monolithic client component
  (`PreviewWorkspace.tsx`) stacking pricing bar, snapshot upload, manual search,
  catalog panel, diff tables, export bar. No navigation/tab structure exists
  (`src/app/layout.tsx` has a single hardcoded nav link).
- `previewFromStore` hard-requires a snapshot; the catalog panel is a side drawer
  *inside* the file workflow (client-side filter over the whole set, 500-row render cap,
  no server-side pagination — `CatalogPanel.tsx`, `listCatalogEntries` returns only
  sku/title/brand).
- Naming is file-centric throughout: `store-json`, `previewFromStore`, `buildReimport`,
  "sanitize file", `rp_cm_roundtrip`.

### 1.3 Dead / vestigial code found by the audit

| Item | Location | Status |
|---|---|---|
| `WooStoreAdapter`, `StorePort`, `renderSkuTemplate`, `ApplyResult` | `core/core-spine.ts:396-609` | Dormant live-REST apply path; referenced only by its own tests |
| `variant_mappings`, `apply_audit` tables | `src/server/db/schema.ts:36,69` | Zero application references; created by migrations, never used |
| `applyModelPatch` | `src/server/store-json/patch.ts:23` | Superseded by `buildReimport`; test-only |
| `sanitizeModel` | `src/server/store-json/sanitize.ts:266` | Superseded by inline sanitize in `buildReimport`; test-only |
| `fetchPricesCached` | `src/server/kicks/service.ts:22` | Not wired into any preview path; test-only |
| `getBulkPriceMap` | `src/server/adapters/kicksdb/client.ts:101` | No references |
| `ApplyConfig` extras (`includeActions`, `dryRunByDefault`, `requireApprovalAboveDeltaPercent`, `concurrency`, `wooBatchSize`, `schedule`) | `core/config.ts:77` | Only `retry` is read |
| `ConnectionConfig.woo` + `WOO_*` env | `core/config.ts:92`, `src/lib/env.ts` | Carried for the dormant adapter |
| `snapshotInfo` action | `src/server/actions/store.ts:36` | Exported, never called |
| Stale docstrings | `defaults.ts` ("12%" vs actual 17), `core-spine.ts` header | Misleading |

Other debt:

- `plans` table grows unbounded (one row per product per preview run, no TTL/cleanup).
- `resolveSkusViaCatalog` fetches cold SKUs sequentially, while `growCatalogFromSkus`
  uses bounded concurrency (6) — a large cold manual list is needlessly slow.
- Server actions, repos, adapters, and all React components are untested (core domain
  and store-json logic are well covered).

---

## 2. Target model — invert the pyramid

**Catalog = core domain. Everything else is a port around it.**

```
                    ┌────────────────────────────┐
   INGESTION        │        CATALOG             │        CONSUMPTION
                    │  catalog_products          │
  KicksDB sync ───▶ │  (market, sku) → product   │ ───▶  Discovery tab (browse/search)
  External feeds ─▶ │  ever-increasing,          │ ───▶  Product CRUD (patch prices,
  Manual entry  ──▶ │  GET-verified,             │        sale rules, KicksDB re-sync)
  Bulk file     ──▶ │  price-carrying            │ ───▶  Reprice & export (Woo snapshot
                    └────────────────────────────┘        round-trip — unchanged)
```

Principles (several stolen from scs-b2b):

1. **Every ingestion source funnels through one pipeline** — the existing
   verify-then-upsert path (`growCatalogFromSkus` / `upsertCatalog`). A feed, a pasted
   SKU list, and a bulk file are the same operation with different frontends.
2. **Precompute at ingestion, read at runtime** (scs-b2b's `FeedSyncService` pattern):
   promote the fields discovery needs (image, min ask, variant count) to indexed
   columns at upsert time so the grid never unpacks jsonb.
3. **URL-as-state discovery** (scs-b2b's catalog page): filters live in the query
   string — shareable, back-button-friendly; view preferences (grid density) live
   client-side.
4. **Append-only, deactivate-never-delete.** The catalog only grows (current
   invariant, same as scs-b2b's `is_active`). CRUD means *edit prices / re-sync /
   flag*, not destroy.
5. **The snapshot remains required only where it is genuinely needed** — matching
   Woo variation ids for a valid re-import. Discovery and product CRUD never touch it.

---

## 3. Proposed app structure

### 3.1 Navigation shell (new)

Replace the single-link header with a real tab bar (scs-b2b's layout pattern:
sticky header, active-tab highlight, mobile collapse):

| Tab | Route | Purpose |
|---|---|---|
| **Discovery** | `/catalog` | Default landing. Browse/search/filter the catalog |
| **Reprice** | `/reprice` (today's `/preview`) | The Woo snapshot round-trip workflow, unchanged |
| **Import** | `/import` | Manual entry + bulk file entry into the catalog |
| **Feeds** | `/feeds` | External feed registry (skeleton now, details TBD) |

Pricing config stays reachable from Discovery and Reprice (it is global).

### 3.2 Discovery tab (`/catalog`)

Server component reading `searchParams` → SQL-level filter/sort/paginate
(replaces `CatalogPanel`'s load-everything + client-filter + 500-cap approach).

- **Brand sidebar with per-brand counts** (scs-b2b `activeBrandsWithCounts`),
  sticky on desktop, chips on mobile; links preserve other filters.
- **Debounced search** on SKU / title.
- **Filters**: market, freshness (fresh vs stale by TTL), price range (on the new
  `min_ask` column). Sort: brand, title, recently added, recently fetched, price.
- **Pagination**: classic paged (24/page, scs-b2b style) — the catalog is
  ever-increasing, so no full-table loads in the browser.
- **Product card**: image (fallback placeholder), brand link, title, monospace SKU
  with copy-to-clipboard, variant/size count, "from X €" (min ask), freshness badge
  (fetchedAt vs TTL). Card click → product detail.
- Bulk affordance kept: select cards (or all filtered) → "Reprice selection" jumps to
  `/reprice` with those SKUs (the existing `previewFromStore(market, skus)` path).

### 3.3 Product detail + CRUD (click a card)

Route `/catalog/[market]/[sku]` (page, not modal — deep-linkable, consistent with
URL-as-state). Sections:

1. **Header**: image, title, brand, SKU, StockX id, market/currency, added/fetched
   timestamps, staleness badge.
2. **Variant table**: per size — size conversions, UPC, offers per delivery type
   (lowest ask + depth), **computed proposed price** under the current pricing rules
   (pure read of `resolveEffectiveRule` + `computePrice`), and the operator override
   state.
3. **CRUD operations** (current feature set is enough — no new pricing concepts):
   - **Sync with KicksDB** — new `refreshCatalogProduct(market, sku)` action:
     re-fetch via `getProduct`, `upsertCatalog`, bump `fetchedAt`. This is the "U"
     that matters for a fetch-only catalog.
   - **Patch price** — per-size manual price lock, reusing
     `setVariationManualPrice` (`src/server/actions/overrides.ts`) verbatim; it is
     already keyed by `parentSku::euSize`, so a lock set here is honored by the next
     reprice/export run with zero new plumbing.
   - **Sale rule** — per-product toggle, reusing `setProductSaleRule`.
   - **No hard delete** (append-only invariant). Optional later: an `archived` flag
     to hide an entry from Discovery without breaking the invariant.
4. **Shortcut**: "Reprice this product" → `/reprice` seeded with this SKU.

> Key insight from the audit: because overrides are keyed by SKU/size — not by Woo
> ids or snapshot state — the product CRUD tab and the file workflow share one
> source of operator intent for free. No migration needed.

### 3.4 Import tab (`/import`) — manual + bulk entry

Two frontends over the **same** existing pipeline (`growCatalogFromSkus`):

- **Manual entry**: textarea of SKUs (`parseSkus` in `src/lib/skus.ts` already
  handles separators) → grow → report `added / known / rejected`.
- **Bulk file entry**: upload CSV/TXT/XLSX, extract the SKU column, same call.
  Large files: chunked with progress (the service already bounds concurrency at 6).
- Every run is recorded in a new **`ingestion_runs`** table (source = `manual` |
  `file` | `feed:<name>` | `preview`, counts, duration, error) — scs-b2b's
  `sync_logs` pattern. This one table then powers both the Import history and the
  Feeds tab status column.

### 3.5 Feeds tab (`/feeds`) — skeleton now, details later

Details deliberately deferred (per discussion), but the seams cost nothing to lay now:

- A **`FeedPort`** concept: a feed is anything that yields SKUs (or full
  `SourceProduct`s) for a market; ingestion goes through the same verify-then-upsert
  pipeline and logs to `ingestion_runs`.
- UI skeleton: feed registry table (name, type, schedule, last run, status,
  added-last-run) + a manual "Run now" — mirroring scs-b2b's sync page
  (lock-guarded, transactional, deactivate-not-delete semantics when we get there).
- KicksDB itself can be re-framed as the built-in first feed (staleness refresh as a
  scheduled run), which makes the feed abstraction honest from day one.

---

## 4. Schema evolution

```
catalog_products
  + image          text      -- promoted from data jsonb at upsert
  + min_ask        numeric   -- min lowest_ask across variants, at upsert
  + variant_count  integer   -- at upsert
  + added_at       timestamp -- first-insert time (fetchedAt keeps meaning "last refresh")
  + (optional later) archived boolean default false
  + index on (market, brand), (market, added_at), title search (ILIKE/trigram)

ingestion_runs (new)
  id, source, market, requested, added, known, rejected, startedAt, finishedAt, error

drop: variant_mappings, apply_audit          -- vestigial (audit §1.3)
plans: add cleanup (delete rows older than N days, or on-new-preview purge)
```

All new columns are derivable from `data` — a one-shot backfill migration recomputes
them for existing rows; `upsertCatalog` maintains them going forward.

---

## 5. Suggested phasing

| Phase | Scope | Risk |
|---|---|---|
| **0 — Cleanup** | Delete dead code (§1.3), drop vestigial tables, fix stale docstrings, add `plans` cleanup. Optionally parallelize `resolveSkusViaCatalog`. | None — pure deletion + docs |
| **1 — Shell + Discovery** | Tab navigation; `/catalog` with server-side filtered/paginated grid; schema additions + backfill; move `/preview` → `/reprice` (redirect kept). | Low — additive |
| **2 — Product detail + CRUD** | Detail route; `refreshCatalogProduct`; manual-price + sale-rule UI on top of existing overrides actions. | Low — reuses proven subsystems |
| **3 — Import tab** | Manual + bulk file entry UIs over `growCatalogFromSkus`; `ingestion_runs`. | Low |
| **4 — Feeds skeleton** | Registry UI + `FeedPort` seam + "run now" for the built-in KicksDB staleness refresh. Real external feeds: separate discussion. | Medium (scheduling) |

Each phase ships independently; the Reprice flow keeps working untouched throughout.

---

## 6. Open questions

1. **Product detail**: full page (proposed, deep-linkable) vs. slide-over drawer on
   the grid?
2. **Archiving**: do we want an `archived` flag from day one, or keep strict
   append-only until a real need appears?
3. **Renames**: adopt catalog-centric naming now (`store-json` → `woo-snapshot`,
   `previewFromStore` → `previewForExport`) or defer to avoid churn during the
   redesign?
4. **Feeds**: formats/suppliers/schedule — parked for the dedicated session.
5. **Markets**: today effectively single-market ("IT"). Should Discovery expose a
   market switcher, or hide it until a second market is real?
