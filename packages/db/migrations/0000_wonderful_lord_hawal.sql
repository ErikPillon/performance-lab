CREATE TYPE "public"."ingest_status" AS ENUM('pending', 'parsing', 'parsed', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sex" AS ENUM('male', 'female', 'unspecified');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('upload', 'strava', 'garmin', 'manual');--> statement-breakpoint
CREATE TYPE "public"."sport" AS ENUM('running', 'cycling', 'swimming', 'rowing', 'walking', 'hiking', 'skiing', 'strength', 'multisport', 'transition', 'other');--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"raw_file_id" uuid,
	"source" "source" DEFAULT 'upload' NOT NULL,
	"source_id" text,
	"dedupe_key" text NOT NULL,
	"sport" "sport" NOT NULL,
	"sub_sport" text,
	"raw_sport" text,
	"start_time" timestamp with time zone NOT NULL,
	"tz_offset_min" smallint,
	"duration_s" double precision,
	"moving_s" double precision,
	"distance_m" double precision,
	"elev_gain_m" double precision,
	"avg_hr" smallint,
	"max_hr" smallint,
	"avg_power_w" smallint,
	"max_power_w" smallint,
	"avg_cadence" double precision,
	"calories" integer,
	"device" text,
	"streams_key" text,
	"sample_count" integer DEFAULT 0 NOT NULL,
	"channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quality_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parser_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"sex" "sex" DEFAULT 'unspecified' NOT NULL,
	"birth_date" date,
	"timezone" text DEFAULT 'Europe/Zurich' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_threshold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"max_hr" smallint,
	"rest_hr" smallint,
	"lthr" smallint,
	"ftp_watts" smallint,
	"css_sec_per_100m" double precision,
	"threshold_pace_sec_per_km" double precision,
	"weight_kg" double precision,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"source" "source" DEFAULT 'upload' NOT NULL,
	"original_filename" text,
	"content_type" text,
	"byte_size" integer NOT NULL,
	"blob_key" text NOT NULL,
	"status" "ingest_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_raw_file_id_raw_file_id_fk" FOREIGN KEY ("raw_file_id") REFERENCES "public"."raw_file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_threshold" ADD CONSTRAINT "athlete_threshold_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_file" ADD CONSTRAINT "raw_file_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_athlete_dedupe_uq" ON "activity" USING btree ("athlete_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "activity_athlete_start_idx" ON "activity" USING btree ("athlete_id","start_time");--> statement-breakpoint
CREATE INDEX "activity_sport_idx" ON "activity" USING btree ("athlete_id","sport","start_time");--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_threshold_athlete_from_uq" ON "athlete_threshold" USING btree ("athlete_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_file_athlete_sha_uq" ON "raw_file" USING btree ("athlete_id","sha256");--> statement-breakpoint
CREATE INDEX "raw_file_status_idx" ON "raw_file" USING btree ("status");