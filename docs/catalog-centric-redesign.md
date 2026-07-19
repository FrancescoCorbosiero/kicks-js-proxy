# Catalog-Centric Redesign — Audit & Design (v2)

Status: **agreed direction, not yet implemented.**
Reference inspiration: [`FrancescoCorbosiero/scs-b2b`](https://github.com/FrancescoCorbosiero/scs-b2b)
(discovery UX, precompute-at-ingestion, sync-log patterns — *not* its margins/accounts/order
funnel, which are out of scope).

## Decisions log

| Question | Decision |
|---|---|
| Product detail | **Drawer** (slide-over on desktop, full-screen sheet on mobile), deep-linkable via query param |
| File round-trip flow | **Kept in code, hidden from UI** — fallback in case we need to reverse |
| Primary Woo integration | **Live REST sync**: pull store state from the WooCommerce REST API, push price updates back via REST |
| Scope | Stays this project's scope: sync our Woo products with the KicksDB catalog. No new i18n work, no margin-rule system, no accounts/orders |
| Product CRUD | Current feature set is enough: patch prices (manual locks), sale rules, re-sync from KicksDB. No hard delete |

---

## 1. Audit — where the codebase stands today

### 1.1 What is solid (keep)

- **Hexagonal core.** `core/core-spine.ts` + `core/config.ts` are framework-free:
  normalized `SourceProduct`/`SourceVariant` model, data-driven scoped pricing rules
  (`resolveEffectiveRule` → `computePrice`), plan/diff engine (`buildPlan`), and the
  `SourcePort` seam.
- **The catalog table already exists and is the strategic asset.**
  `catalog_products` (`src/server/db/schema.ts:89`) is ever-increasing, unique by
  `(market, sku)`, GET-verified (every SKU is guaranteed fetchable on KicksDB), and
  stores the full `SourceProduct` jsonb. Both preview paths feed it
  (`resolveSkusViaCatalog`, `growCatalogFromSkus` in `src/server/catalog/service.ts`).
- **Overrides are already snapshot-independent.** `src/server/overrides/` keys manual
  price locks and sale rules by stable `parentSku::euSize` identities — not Woo row
  ids. Product-level CRUD can be built on the catalog *now*, and any sync/export flow
  picks the same overrides up automatically. Precedence stays fixed:
  **manual lock > sale rule > computed price**.
- **The matching + plan engine is transport-agnostic.** `resolveFromModel`
  (GTIN-first, then EU-size, `src/server/store-json/match.ts`) consumes a parsed Woo
  model — it does not care whether that model was *uploaded as a file* or *pulled via
  REST*. This is the load-bearing fact for the REST pivot: the battle-tested
  matching/plan logic transfers unchanged.

### 1.2 The core problem: the file is the center, the catalog is a cache

Today's mental model (README, module names, UI) is:
*upload snapshot file → preview against it → export patched file.*

- The **only** real screen is `/preview` — a 668-line monolithic client component
  (`PreviewWorkspace.tsx`) stacking every panel. No navigation/tab structure exists
  (`src/app/layout.tsx` has a single hardcoded nav link).
- `previewFromStore` hard-requires an uploaded snapshot; the catalog panel is a side
  drawer *inside* the file workflow (client-side filter over the whole set, 500-row
  render cap, no server-side pagination).
- Naming is file-centric throughout: `store-json`, `previewFromStore`,
  `buildReimport`, "sanitize file", `rp_cm_roundtrip`.

### 1.3 Dormant vs. dead code — revised under the REST decision

The audit initially classed the live-apply machinery as dead. With REST sync as the
main goal, most of it is **dormant infrastructure to revive**, not waste:

**Revive (was flagged dead, now the seed of the REST path):**

| Item | Location | New role |
|---|---|---|
| `StorePort` + `WooStoreAdapter` | `core/core-spine.ts:396-609` | The REST adapter: `resolveMappings`, `applyPrices` (per-parent `variations/batch`), `upsertProduct`. Has tests already |
| `ConnectionConfig.woo` + `WOO_*` env | `core/config.ts:92`, `src/lib/env.ts` | Woo REST credentials (base URL, consumer key/secret) |
| `ApplyConfig` (`dryRunByDefault`, `concurrency`, `wooBatchSize`, `retry`, …) | `core/config.ts:77` | Apply-run safety knobs |
| `apply_audit` table | `schema.ts:69` | One row per apply attempt (incl. dry runs) — the sync history |
| `variant_mappings` table | `schema.ts:36` | Optional cache of confirmed StockX-variant ↔ Woo-variation links so re-syncs skip re-matching; also the home for future manual matches |

**Still dead (delete in cleanup):**

| Item | Location |
|---|---|
| `applyModelPatch` (superseded by `buildReimport`) | `src/server/store-json/patch.ts:23` |
| `sanitizeModel` (superseded by inline sanitize) | `src/server/store-json/sanitize.ts:266` |
| `fetchPricesCached` (never wired) | `src/server/kicks/service.ts:22` |
| `getBulkPriceMap` (no references) | `src/server/adapters/kicksdb/client.ts:101` |
| `snapshotInfo` action (exported, uncalled) | `src/server/actions/store.ts:36` |
| Stale docstrings ("12%" vs 17, "dry-run apply" framing) | `defaults.ts`, `core-spine.ts` header |

Other debt (unchanged): `plans` table grows unbounded (needs TTL/cleanup);
`resolveSkusViaCatalog` fetches cold SKUs sequentially while `growCatalogFromSkus`
bounds concurrency at 6; server actions / repos / components are untested (core and
store-json logic are well covered).

---

## 2. Target model

**Catalog = core domain. Woo is a sync target reached over REST. The file flow is a
hidden fallback.**

```
                    ┌────────────────────────────┐
   INGESTION        │        CATALOG             │        CONSUMPTION
                    │  catalog_products          │
  KicksDB sync ───▶ │  (market, sku) → product   │ ───▶  Discovery tab (browse/search)
  External feeds ─▶ │  ever-increasing,          │ ───▶  Product drawer: CRUD
  Manual entry  ──▶ │  GET-verified,             │        (patch price, sale rule,
  Bulk file     ──▶ │  price-carrying            │         re-sync from KicksDB)
                    └────────────────────────────┘ ───▶  WOO SYNC via REST
                                                          pull store state → plan diff
                                                          → push prices (variations/batch)
                                                   ───▶  (hidden) file round-trip fallback
```

Principles (several from scs-b2b):

1. **Every ingestion source funnels through one pipeline** — the existing
   verify-then-upsert path (`growCatalogFromSkus` / `upsertCatalog`).
2. **Precompute at ingestion, read at runtime**: promote the fields discovery needs
   (image, min ask, variant count) to indexed columns at upsert time.
3. **URL-as-state discovery**: filters live in the query string.
4. **Append-only, deactivate-never-delete.** CRUD means edit prices / re-sync / flag,
   never destroy.
5. **One store-state model, two transports.** The Woo model (`store-json/model.ts`)
   stays the single parsed representation of the store; it can be *pulled* (REST,
   primary) or *uploaded* (file, hidden fallback). Matching, plan, overrides, and
   sanitize all sit above that seam and never know the difference.

---

## 3. Proposed app structure

### 3.1 Navigation shell

| Tab | Route | Purpose |
|---|---|---|
| **Discovery** | `/catalog` | Default landing. Browse/search/filter the catalog; product drawer |
| **Sync** | `/sync` | Woo REST sync: pull store state → diff preview → apply prices |
| **Import** | `/import` | Manual entry + bulk file entry into the catalog |
| **Feeds** | `/feeds` | External feed registry (skeleton now, details TBD) |
| *(hidden)* | `/preview` | The file round-trip flow — route kept, no nav link |

Pricing config stays reachable from Discovery and Sync (it is global). Existing
i18n (it/en dictionaries) is reused for new strings; no i18n system work.

### 3.2 Discovery tab (`/catalog`)

Server component reading `searchParams` → SQL-level filter/sort/paginate (replaces
`CatalogPanel`'s load-everything + client-filter + 500-cap approach).

- **Brand sidebar with per-brand counts** (scs-b2b pattern), sticky on desktop,
  horizontal chips on mobile; brand links preserve other filters.
- **Debounced search** on SKU / title.
- **Filters**: freshness (fresh vs stale by TTL), price range (new `min_ask` column).
  **Sort**: brand, title, recently added, recently fetched, price.
- **Pagination**: classic paged (24/page) — no full-table loads in the browser.
- **Product card**: image (placeholder fallback), brand, title, monospace SKU with
  copy-to-clipboard, size count, "from X €" (min ask), freshness badge. Click →
  drawer.
- Bulk affordance: select cards (or all filtered) → "Sync selection" seeds `/sync`
  with those SKUs.

### 3.3 Product drawer (click a card)

**Slide-over drawer on desktop; full-screen sheet on mobile** (no cramped panel —
on small viewports it takes over the screen with a sticky close/back header).
Deep-linkable as `/catalog?product=<sku>` so URL-as-state survives and back-button
closes the drawer. Content:

1. **Header**: image, title, brand, SKU, StockX id, market/currency, added/fetched
   timestamps, staleness badge.
2. **Variant table** (mobile: stacked rows, not a wide table): per size — size
   conversions, UPC, offers per delivery type (lowest ask + depth), **computed
   proposed price** under current pricing rules, and the operator override state.
3. **Operations** (current feature set, nothing new conceptually):
   - **Re-sync from KicksDB** — new `refreshCatalogProduct(market, sku)` action:
     re-fetch via `getProduct`, `upsertCatalog`, bump `fetchedAt`.
   - **Patch price** — per-size manual lock, reusing `setVariationManualPrice`
     verbatim (already keyed by `parentSku::euSize`; the next Woo sync honors it
     with zero new plumbing).
   - **Sale rule** — per-product toggle, reusing `setProductSaleRule`.
   - **No hard delete** (append-only invariant). Optional later: `archived` flag.
4. **Shortcut**: "Sync this product to Woo" → `/sync` seeded with this SKU.

### 3.4 Woo Sync tab (`/sync`) — the main goal

Replaces the visible part of the file workflow. Same engine, new transport:

**Pull (store state via REST).** A `pullStoreState` action walks the Woo REST API
(`GET /products` + `GET /products/{id}/variations`, paginated 100/page, with the
existing `requestJson` retry/backoff infra) and materializes the same shape
`parseStoreModel` produces today. Persist it in `store_snapshot` with a new
`source: "rest" | "upload"` column — so downstream code sees "the active snapshot"
exactly as before, and the staleness warning becomes a "Refresh from store" button
instead of "re-export from Woo and re-upload".

**Plan (unchanged).** `previewFromStore` → `resolveFromModel` (GTIN-first, EU-size)
→ `buildPlan` with overrides overlaid. The diff UI (per-product collapsible tables,
row selection, manual-price cells) is lifted from `PreviewWorkspace` largely as-is.

**Push (apply via REST).** Revive `WooStoreAdapter.applyPrices`: group selected
`update` items by parent product → `POST /products/{id}/variations/batch`
(`wooBatchSize` ≤ 100, `concurrency` from `ApplyConfig`). Safety rails:

- **Dry-run by default** (`ApplyConfig.dryRunByDefault` — finally meaningful):
  first click shows exactly what would be written; a second, explicit "Apply N
  changes" confirms.
- `maxDeltaPercent` guardrail already applies at plan time.
- Every run (incl. dry runs) recorded in `apply_audit` → a sync-history list on the
  tab (scs-b2b's sync-log pattern).
- **Update-only at first**: no product/variation creation over REST (`upsertProduct`
  stays dormant). Matches "current features are enough".
- **Sanitize stays file-only for now.** Deleting ghost variations over live REST is
  destructive; the hidden `/preview` flow keeps that capability until we decide to
  port it with an explicit confirm step.

**Fallback.** `/preview` (upload → export) remains fully functional, just unlinked.
Because both transports feed the same `store_snapshot` + plan engine, reversing is a
one-line nav change.

### 3.5 Import tab (`/import`)

Two frontends over the same existing pipeline (`growCatalogFromSkus`):

- **Manual entry**: textarea of SKUs (`parseSkus` handles separators) → grow →
  report `added / known / rejected`.
- **Bulk file entry**: upload CSV/TXT/XLSX, extract the SKU column, same call
  (service already bounds concurrency at 6).
- Every run recorded in a new **`ingestion_runs`** table (source = `manual` | `file`
  | `feed:<name>` | `preview`, counts, duration, error) — powers Import history and
  the Feeds tab status column.

### 3.6 Feeds tab (`/feeds`) — skeleton now, details later

- A **`FeedPort`** concept: a feed is anything that yields SKUs (or full
  `SourceProduct`s) for a market; ingestion goes through the same verify-then-upsert
  pipeline and logs to `ingestion_runs`.
- UI skeleton: registry table (name, type, schedule, last run, status, added-last-run)
  + manual "Run now".
- KicksDB staleness refresh re-framed as the built-in first feed, keeping the
  abstraction honest. Real external feeds: separate discussion.

---

## 4. Schema evolution

```
catalog_products
  + image          text      -- promoted from data jsonb at upsert
  + min_ask        numeric   -- min lowest_ask across variants, at upsert
  + variant_count  integer   -- at upsert
  + added_at       timestamp -- first-insert time (fetchedAt keeps meaning "last refresh")
  + indexes: (market, brand), (market, added_at), title search (ILIKE/trigram)

store_snapshot
  + source         text      -- "rest" | "upload" (default "upload" for backfill)

ingestion_runs (new)
  id, source, market, requested, added, known, rejected, startedAt, finishedAt, error

apply_audit      -- KEPT & wired: one row per sync apply (incl. dry runs)
variant_mappings -- KEPT (dormant): confirmed-link cache / future manual matches
plans            -- add cleanup (delete rows older than N days)
```

All new `catalog_products` columns are derivable from `data` — one backfill
migration recomputes them; `upsertCatalog` maintains them going forward.

---

## 5. Phasing

| Phase | Scope | Notes |
|---|---|---|
| **0 — Cleanup** | Delete the *still-dead* items (§1.3 second table), fix stale docstrings, `plans` cleanup, parallelize `resolveSkusViaCatalog`. **Do not** touch the Woo adapter / apply tables — they get revived | Pure deletion + docs |
| **1 — Shell + Discovery** | Tab navigation; `/catalog` grid (server-side filter/sort/paginate); schema additions + backfill; product drawer with CRUD (patch price, sale rule, KicksDB re-sync); `/preview` unlinked from nav | The catalog-centric shift |
| **2 — Woo REST sync** | `pullStoreState` (REST pull → `store_snapshot`), `/sync` tab (diff preview lifted from `PreviewWorkspace`), revive `WooStoreAdapter.applyPrices` with dry-run default + `apply_audit` history | The main goal |
| **3 — Import tab** | Manual + bulk file entry over `growCatalogFromSkus`; `ingestion_runs` | |
| **4 — Feeds skeleton** | Registry UI + `FeedPort` seam + "run now" for the built-in KicksDB staleness refresh | Details TBD |

Phases 1 and 2 are independent enough to swap if getting REST sync live sooner
matters more than the discovery grid.

---

## 6. Remaining open questions

1. **Woo credentials & store size**: `WOO_*` env vars exist but were optional —
   need the real base URL + consumer key/secret with read/write on products.
   Roughly how many products/variations is the store? (Drives pull pagination time
   and whether the pull needs a progress UI.)
2. **Pull cadence**: on-demand "Refresh from store" button only, or also a scheduled
   pull (would piggyback on the Feeds scheduling work)?
3. **Sanitize over REST**: keep file-only (current plan), or eventually port
   ghost-variation deletion to REST behind an explicit multi-step confirm
   (scs-b2b's dropship confirm pattern)?
4. **Feeds**: formats/suppliers/schedule — parked for the dedicated session.
