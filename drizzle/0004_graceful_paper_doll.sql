CREATE TABLE "store_overrides" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
