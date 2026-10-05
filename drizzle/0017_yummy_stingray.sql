CREATE TABLE "media_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"store_product_id" integer,
	"title" text NOT NULL,
	"images" jsonb NOT NULL,
	"refusals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publish" boolean NOT NULL,
	"replace" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attached" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_jobs_open_sku_idx" ON "media_jobs" USING btree ("sku") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "media_jobs_due_idx" ON "media_jobs" USING btree ("status","next_attempt_at");