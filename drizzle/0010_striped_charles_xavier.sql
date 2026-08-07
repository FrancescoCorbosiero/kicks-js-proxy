ALTER TABLE "catalog_products" ADD COLUMN "category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "secondary_category" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "gender" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "product_type" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "catalog_market_category_idx" ON "catalog_products" USING btree ("market","category","secondary_category");--> statement-breakpoint
CREATE INDEX "catalog_market_gender_idx" ON "catalog_products" USING btree ("market","gender");