CREATE TABLE "catalog_products" (
	"market" text NOT NULL,
	"sku" text NOT NULL,
	"stockx_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_products_market_sku_pk" PRIMARY KEY("market","sku")
);
--> statement-breakpoint
CREATE INDEX "catalog_brand_idx" ON "catalog_products" USING btree ("brand");