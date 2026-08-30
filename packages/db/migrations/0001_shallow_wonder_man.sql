CREATE TABLE "activity_load" (
	"activity_id" uuid PRIMARY KEY NOT NULL,
	"athlete_id" uuid NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"load" double precision,
	"load_method" text DEFAULT 'none' NOT NULL,
	"trimp" double precision,
	"hr_tss" double precision,
	"pace_tss" double precision,
	"power_tss" double precision,
	"swim_tss" double precision,
	"intensity_factor" double precision,
	"np_w" double precision,
	"variability_index" double precision,
	"ngp_mps" double precision,
	"gap_sec_per_km" double precision,
	"swim_pace_sec_per_100m" double precision,
	"efficiency_factor" double precision,
	"decoupling_pct" double precision,
	"time_in_zones" jsonb,
	"calc_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "athlete_daily" (
	"athlete_id" uuid NOT NULL,
	"date" date NOT NULL,
	"load" double precision DEFAULT 0 NOT NULL,
	"duration_s" double precision DEFAULT 0 NOT NULL,
	"distance_m" double precision DEFAULT 0 NOT NULL,
	"activities" smallint DEFAULT 0 NOT NULL,
	"ctl" double precision DEFAULT 0 NOT NULL,
	"atl" double precision DEFAULT 0 NOT NULL,
	"tsb" double precision DEFAULT 0 NOT NULL,
	"ramp_rate" double precision DEFAULT 0 NOT NULL,
	"weekly_load" double precision DEFAULT 0 NOT NULL,
	"monotony" double precision DEFAULT 0 NOT NULL,
	"strain" double precision DEFAULT 0 NOT NULL,
	"acwr" double precision DEFAULT 0 NOT NULL,
	"calc_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_daily_athlete_id_date_pk" PRIMARY KEY("athlete_id","date")
);
--> statement-breakpoint
ALTER TABLE "activity_load" ADD CONSTRAINT "activity_load_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_load" ADD CONSTRAINT "activity_load_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_daily" ADD CONSTRAINT "athlete_daily_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_load_athlete_start_idx" ON "activity_load" USING btree ("athlete_id","start_time");--> statement-breakpoint
CREATE INDEX "activity_load_method_idx" ON "activity_load" USING btree ("load_method");--> statement-breakpoint
CREATE INDEX "athlete_daily_date_idx" ON "athlete_daily" USING btree ("date");