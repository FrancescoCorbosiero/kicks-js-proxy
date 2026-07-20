CREATE TABLE "feed_items" (
	"feed" text NOT NULL,
	"sku" text NOT NULL,
	"eu_norm" text NOT NULL,
	"size_label" text DEFAULT '' NOT NULL,
	"size_us" text DEFAULT '' NOT NULL,
	"barcode" text DEFAULT '' NOT NULL,
	"offer_price" numeric,
	"presented_price" numeric,
	"quantity" integer DEFAULT 0 NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"brand_name" text DEFAULT '' NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"raw" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feed_items_feed_sku_eu_norm_pk" PRIMARY KEY("feed","sku","eu_norm")
);
--> statement-breakpoint
CREATE INDEX "feed_items_feed_active_idx" ON "feed_items" USING btree ("feed","active");--> statement-breakpoint
CREATE INDEX "feed_items_feed_sku_idx" ON "feed_items" USING btree ("feed","sku");