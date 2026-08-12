CREATE TABLE "order_workflow" (
	"order_id" integer PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"carrier" text DEFAULT '' NOT NULL,
	"tracking_code" text DEFAULT '' NOT NULL,
	"tracking_url" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status_changed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_orders" (
	"id" integer PRIMARY KEY NOT NULL,
	"number" text DEFAULT '' NOT NULL,
	"woo_status" text DEFAULT '' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"total" numeric,
	"customer_name" text DEFAULT '' NOT NULL,
	"customer_email" text DEFAULT '' NOT NULL,
	"customer_phone" text DEFAULT '' NOT NULL,
	"customer_note" text DEFAULT '' NOT NULL,
	"payment_method" text DEFAULT '' NOT NULL,
	"shipping" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"modified_at" timestamp with time zone,
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "store_orders_created_idx" ON "store_orders" USING btree ("created_at");