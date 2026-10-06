CREATE TABLE "price_ledger" (
	"variation_id" integer PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"sku" text NOT NULL,
	"eu_size" text DEFAULT '' NOT NULL,
	"price" numeric NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_price" numeric,
	"seen_at" timestamp with time zone,
	"title" text DEFAULT '' NOT NULL,
	"size_label" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "price_ledger_product_idx" ON "price_ledger" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "price_ledger_open_idx" ON "price_ledger" USING btree ("seen_at") WHERE store_price is not null;