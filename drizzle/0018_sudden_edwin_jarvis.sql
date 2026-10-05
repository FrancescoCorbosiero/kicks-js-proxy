CREATE TABLE "collection_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid,
	"term_id" integer NOT NULL,
	"category_name" text DEFAULT '' NOT NULL,
	"product_id" integer NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"product_name" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"trigger" text NOT NULL,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"term_id" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"match" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"members" integer,
	"held" jsonb,
	"last_error" text,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_index" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"sku" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"type" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"permalink" text DEFAULT '' NOT NULL,
	"categories" jsonb NOT NULL,
	"tags" jsonb NOT NULL,
	"brands" jsonb NOT NULL,
	"attributes" jsonb NOT NULL,
	"price" numeric,
	"on_sale" boolean DEFAULT false NOT NULL,
	"stock_status" text DEFAULT '' NOT NULL,
	"date_created" timestamp with time zone,
	"date_modified" timestamp with time zone,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "collection_changes_at_idx" ON "collection_changes" USING btree ("at");--> statement-breakpoint
CREATE INDEX "collection_changes_collection_idx" ON "collection_changes" USING btree ("collection_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "smart_collections_term_idx" ON "smart_collections" USING btree ("term_id");--> statement-breakpoint
CREATE INDEX "store_index_modified_idx" ON "store_index" USING btree ("date_modified");--> statement-breakpoint
CREATE INDEX "store_index_seen_idx" ON "store_index" USING btree ("seen_at");