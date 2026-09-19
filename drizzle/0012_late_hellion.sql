ALTER TABLE "plans" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "source" text DEFAULT 'kicksdb' NOT NULL;--> statement-breakpoint
CREATE INDEX "plans_run_idx" ON "plans" USING btree ("run_id");