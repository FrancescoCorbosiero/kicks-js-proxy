CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"market" text NOT NULL,
	"requested" integer DEFAULT 0 NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"known" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "store_pull_products" (
	"run_id" uuid NOT NULL,
	"store_product_id" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "store_pull_products_run_id_store_product_id_pk" PRIMARY KEY("run_id","store_product_id")
);
--> statement-breakpoint
CREATE TABLE "store_pull_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"cursor_page" integer DEFAULT 1 NOT NULL,
	"products_fetched" integer DEFAULT 0 NOT NULL,
	"variations_fetched" integer DEFAULT 0 NOT NULL,
	"total_products" integer,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "image" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "min_ask" numeric;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "variant_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD COLUMN "added_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "store_snapshot" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "store_pull_products" ADD CONSTRAINT "store_pull_products_run_id_store_pull_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."store_pull_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingestion_runs_started_idx" ON "ingestion_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "catalog_market_brand_idx" ON "catalog_products" USING btree ("market","brand");--> statement-breakpoint
CREATE INDEX "catalog_market_added_idx" ON "catalog_products" USING btree ("market","added_at");--> statement-breakpoint
CREATE INDEX "catalog_market_fetched_idx" ON "catalog_products" USING btree ("market","fetched_at");--> statement-breakpoint
-- Backfill the denormalized discovery columns for rows that predate them.
UPDATE "catalog_products" cp SET
	"image" = COALESCE(cp."data"->>'image', ''),
	"variant_count" = COALESCE(jsonb_array_length(cp."data"->'variants'), 0),
	"min_ask" = (
		SELECT MIN((o->>'lowestAsk')::numeric)
		FROM jsonb_array_elements(COALESCE(cp."data"->'variants', '[]'::jsonb)) v,
		     jsonb_array_elements(COALESCE(v->'offers', '[]'::jsonb)) o
		WHERE (o->>'lowestAsk')::numeric > 0
	),
	"added_at" = cp."fetched_at";
