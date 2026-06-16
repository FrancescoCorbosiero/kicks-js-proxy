import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppConfig } from "@core/config";
import type { Plan, PlanItem, ApplyResult } from "@core/core-spine";

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

/** One row per apply attempt (including dry runs). */
export const applyAudit = pgTable("apply_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  planId: uuid("plan_id")
    .notNull()
    .references(() => plans.id),
  jobId: text("job_id"),
  status: text("status", {
    enum: ["queued", "running", "dry_run", "applied", "partial", "failed"],
  }).notNull(),
  dryRun: boolean("dry_run").notNull(),
  updatedCount: integer("updated_count").notNull().default(0),
  failed: jsonb("failed").$type<ApplyResult["failed"]>().notNull().default([]),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export type ConfigRow = typeof config.$inferSelect;
export type VariantMappingRow = typeof variantMappings.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type ApplyAuditRow = typeof applyAudit.$inferSelect;
