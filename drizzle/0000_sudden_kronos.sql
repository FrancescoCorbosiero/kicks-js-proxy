CREATE TABLE "apply_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"job_id" text,
	"status" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"failed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "config" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"data" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"currency" text NOT NULL,
	"market" text NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"items" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variant_mappings" (
	"stockx_variant_id" text PRIMARY KEY NOT NULL,
	"store_product_id" integer NOT NULL,
	"store_variation_id" integer NOT NULL,
	"upc" text,
	"current_price" numeric,
	"strategy" text NOT NULL,
	"confirmed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apply_audit" ADD CONSTRAINT "apply_audit_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variant_mappings_upc_idx" ON "variant_mappings" USING btree ("upc");--> statement-breakpoint
CREATE INDEX "variant_mappings_product_idx" ON "variant_mappings" USING btree ("store_product_id");