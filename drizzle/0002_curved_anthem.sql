ALTER TABLE "apply_audit" ALTER COLUMN "plan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "apply_audit" ADD COLUMN "result" jsonb;