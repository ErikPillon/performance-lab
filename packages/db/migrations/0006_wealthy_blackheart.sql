CREATE TABLE "athlete_wellness" (
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"resting_hr" smallint,
	"hrv_rmssd_ms" double precision,
	"sleep_hours" double precision,
	"sleep_score" smallint,
	"weight_kg" double precision,
	"feel" smallint,
	"note" text,
	"source" "source" DEFAULT 'manual' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_wellness_athlete_id_date_pk" PRIMARY KEY("athlete_id","date")
);
--> statement-breakpoint
ALTER TABLE "athlete_wellness" ADD CONSTRAINT "athlete_wellness_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;