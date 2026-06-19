CREATE TABLE "store_snapshot" (
	"id" text PRIMARY KEY DEFAULT 'current' NOT NULL,
	"site_url" text,
	"product_count" integer DEFAULT 0 NOT NULL,
	"data" jsonb NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
