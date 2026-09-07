CREATE TYPE "public"."connection_provider" AS ENUM('strava');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'needs_reauth', 'error', 'disconnected');--> statement-breakpoint
CREATE TABLE "athlete_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"provider" "connection_provider" NOT NULL,
	"provider_athlete_id" text,
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"synced_through" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "athlete_connection" ADD CONSTRAINT "athlete_connection_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_connection_athlete_provider_uq" ON "athlete_connection" USING btree ("athlete_id","provider");