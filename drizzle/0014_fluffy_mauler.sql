CREATE TABLE "store_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"market" text NOT NULL,
	"skus" jsonb NOT NULL,
	"cursor" integer DEFAULT 0 NOT NULL,
	"planned" integer DEFAULT 0 NOT NULL,
	"totals" jsonb NOT NULL,
	"not_found" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"not_found_total" integer DEFAULT 0 NOT NULL,
	"delisted" integer DEFAULT 0 NOT NULL,
	"warning" text,
	"catalog" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
