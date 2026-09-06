CREATE TYPE "public"."block_focus" AS ENUM('base', 'build', 'peak', 'taper', 'race', 'recovery', 'offseason', 'other');--> statement-breakpoint
CREATE TYPE "public"."race_priority" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TABLE "race" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"sport" "sport" DEFAULT 'running' NOT NULL,
	"priority" "race_priority" DEFAULT 'B' NOT NULL,
	"distance_m" double precision,
	"goal_time_s" double precision,
	"result_time_s" double precision,
	"activity_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_block" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"athlete_id" uuid NOT NULL,
	"name" text NOT NULL,
	"focus" "block_focus" DEFAULT 'base' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"target_weekly_load" double precision,
	"race_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "race" ADD CONSTRAINT "race_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "race" ADD CONSTRAINT "race_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_block" ADD CONSTRAINT "training_block_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_block" ADD CONSTRAINT "training_block_race_id_race_id_fk" FOREIGN KEY ("race_id") REFERENCES "public"."race"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "race_athlete_date_idx" ON "race" USING btree ("athlete_id","date");--> statement-breakpoint
CREATE INDEX "training_block_athlete_start_idx" ON "training_block" USING btree ("athlete_id","start_date");