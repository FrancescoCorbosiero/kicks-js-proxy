import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppConfig } from "@core/config";
import type { Plan, PlanItem, ApplyResult, SourceProduct } from "@core/core-spine";
import type { StoreOverrides } from "@/server/overrides/model";

/**
 * The persisted AppConfig. Secrets (in ConnectionConfig) are injected from env at
 * read time and never written here — see src/server/config. We keep history by
 * row; exactly one row has is_active = true.
 */
export const config = pgTable("config", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default("default"),
  data: jsonb("data").$type<AppConfig>().notNull(),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Confirmed StockX-variant -> Woo-variation links, so matching is cheap on rerun.
 * Matched first by UPC (global_unique_id), then the SKU template, then manual.
 */
export const variantMappings = pgTable(
  "variant_mappings",
  {
    stockxVariantId: text("stockx_variant_id").primaryKey(),
    storeProductId: integer("store_product_id").notNull(),
    storeVariationId: integer("store_variation_id").notNull(),
    upc: text("upc"),
    currentPrice: numeric("current_price", { mode: "number" }),
    strategy: text("strategy", { enum: ["upc", "skuPattern", "manual"] }).notNull(),
    confirmed: boolean("confirmed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("variant_mappings_upc_idx").on(t.upc),
    index("variant_mappings_product_idx").on(t.storeProductId),
  ],
);

/** A generated preview. "Apply" just executes a stored plan's items. */
export const plans = pgTable("plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  sku: text("sku").notNull(),
  currency: text("currency").notNull(),
  market: text("market").notNull(),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  items: jsonb("items").$type<PlanItem[]>().notNull(),
  // denormalized counts for quick listing: { update, create, noop, skip }
  summary: jsonb("summary").$type<Record<Plan["items"][number]["action"], number>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per apply attempt (including dry runs). Job-level: planId optional. */
export const applyAudit = pgTable("apply_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id").references(() => plans.id),
  jobId: text("job_id"),
  status: text("status", {
    enum: ["queued", "running", "dry_run", "applied", "partial", "failed"],
  }).notNull(),
  dryRun: boolean("dry_run").notNull(),
  updatedCount: integer("updated_count").notNull().default(0),
  failed: jsonb("failed").$type<ApplyResult["failed"]>().notNull().default([]),
  result: jsonb("result").$type<Record<string, unknown>>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/**
 * The core domain table: every StockX product successfully looked up on KicksDB
 * is upserted here, keyed by (market, sku). Ever-increasing (SKUs never leave);
 * freshness is decided by fetchedAt + the config TTL. The image/minAsk/
 * variantCount columns are denormalized from `data` at upsert time so the
 * discovery grid can filter/sort/paginate in SQL without unpacking jsonb.
 * addedAt is the first-insert time (fetchedAt means "last refreshed").
 */
export const catalogProducts = pgTable(
  "catalog_products",
  {
    market: text("market").notNull(),
    sku: text("sku").notNull(),
    stockxId: text("stockx_id").notNull(),
    title: text("title").notNull().default(""),
    brand: text("brand").notNull().default(""),
    image: text("image").notNull().default(""),
    minAsk: numeric("min_ask", { mode: "number" }),
    variantCount: integer("variant_count").notNull().default(0),
    data: jsonb("data").$type<SourceProduct>().notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.market, t.sku] }),
    index("catalog_brand_idx").on(t.brand),
    index("catalog_market_brand_idx").on(t.market, t.brand),
    index("catalog_market_added_idx").on(t.market, t.addedAt),
    index("catalog_market_fetched_idx").on(t.market, t.fetchedAt),
  ],
);

export type CatalogProductRow = typeof catalogProducts.$inferSelect;

/**
 * The WooCommerce store-state model (single active snapshot). Preview, the REST
 * apply and the JSON export all read it. Stored whole as jsonb so nothing is
 * lost. `source` records the transport that produced it: "rest" (pulled live
 * from the Woo REST API — the primary path) or "upload" (the hidden file
 * round-trip fallback).
 */
export const storeSnapshot = pgTable("store_snapshot", {
  id: text("id").primaryKey().default("current"),
  siteUrl: text("site_url"),
  productCount: integer("product_count").notNull().default(0),
  source: text("source", { enum: ["upload", "rest"] }).notNull().default("upload"),
  data: jsonb("data").$type<unknown>().notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StoreSnapshotRow = typeof storeSnapshot.$inferSelect;

/**
 * Operator overrides that outlive the snapshot: per-product sale-rule choice and
 * per-variation manual locked prices. Single active row (one operator), stored
 * whole as jsonb — keyed by stable SKU/size identities, not Woo row ids.
 */
export const storeOverrides = pgTable("store_overrides", {
  id: text("id").primaryKey().default("current"),
  data: jsonb("data").$type<StoreOverrides>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StoreOverridesRow = typeof storeOverrides.$inferSelect;

/**
 * One row per catalog-ingestion run, whatever the frontend: manual entry, bulk
 * file, a feed run, or growth from a preview. Powers the Import history and the
 * Feeds tab status column.
 */
export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // "manual" | "file" | "feed:kicksdb" | "preview" — free-form so new feeds
    // don't need a migration.
    source: text("source").notNull(),
    market: text("market").notNull(),
    requested: integer("requested").notNull().default(0),
    added: integer("added").notNull().default(0),
    known: integer("known").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("ingestion_runs_started_idx").on(t.startedAt)],
);

export type IngestionRunRow = typeof ingestionRuns.$inferSelect;

/**
 * A resumable Woo REST store pull. The pull walks GET /products (+ variations)
 * in chunks driven by repeated advance calls; the cursor lives here so a pull
 * survives interruption and shows live progress. Pulled products accumulate in
 * store_pull_products until the run completes, then become the active snapshot.
 */
export const storePullRuns = pgTable("store_pull_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status", { enum: ["running", "done", "failed", "cancelled"] })
    .notNull()
    .default("running"),
  // Next Woo /products page to fetch (1-based).
  cursorPage: integer("cursor_page").notNull().default(1),
  productsFetched: integer("products_fetched").notNull().default(0),
  variationsFetched: integer("variations_fetched").notNull().default(0),
  // From Woo's X-WP-Total header on the first page; null until known.
  totalProducts: integer("total_products"),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type StorePullRunRow = typeof storePullRuns.$inferSelect;

/**
 * External-feed offers: one row per (feed, sku, size). The KicksDB catalog
 * stays pure — feed data lives here and a product-level ownership switch
 * decides which source drives a product. Rows are deactivated (never deleted)
 * when they vanish from a sync, so history survives and nothing churns.
 */
export const feedItems = pgTable(
  "feed_items",
  {
    feed: text("feed").notNull(), // "goldensneakers"
    sku: text("sku").notNull(), // canonical style code (skuKey)
    euNorm: text("eu_norm").notNull(), // canonical numeric size key ("36.67")
    sizeLabel: text("size_label").notNull().default(""), // human ("36 2/3")
    sizeUs: text("size_us").notNull().default(""),
    barcode: text("barcode").notNull().default(""), // EAN → Woo global_unique_id
    offerPrice: numeric("offer_price", { mode: "number" }), // supplier cost — internal only
    presentedPrice: numeric("presented_price", { mode: "number" }), // FINAL retail (VAT+markup upstream)
    quantity: integer("quantity").notNull().default(0),
    productName: text("product_name").notNull().default(""),
    brandName: text("brand_name").notNull().default(""),
    image: text("image").notNull().default(""),
    active: boolean("active").notNull().default(true),
    raw: jsonb("raw").$type<unknown>(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.feed, t.sku, t.euNorm] }),
    index("feed_items_feed_active_idx").on(t.feed, t.active),
    index("feed_items_feed_sku_idx").on(t.feed, t.sku),
  ],
);

export type FeedItemRow = typeof feedItems.$inferSelect;

/** Staging area for an in-flight pull: one row per pulled parent product. */
export const storePullProducts = pgTable(
  "store_pull_products",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => storePullRuns.id, { onDelete: "cascade" }),
    storeProductId: integer("store_product_id").notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.storeProductId] })],
);

export type ConfigRow = typeof config.$inferSelect;
export type VariantMappingRow = typeof variantMappings.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type ApplyAuditRow = typeof applyAudit.$inferSelect;
