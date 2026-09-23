CREATE TYPE "public"."coverage_group" AS ENUM('foot', 'bike', 'all');--> statement-breakpoint
CREATE TABLE "activity_track" (
	"activity_id" uuid PRIMARY KEY NOT NULL,
	"athlete_id" uuid NOT NULL,
	"sport" "sport" NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"parts" jsonb NOT NULL,
	"points" integer NOT NULL,
	"south" double precision NOT NULL,
	"west" double precision NOT NULL,
	"north" double precision NOT NULL,
	"east" double precision NOT NULL,
	"version" smallint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_area" (
	"athlete_id" uuid NOT NULL,
	"group" "coverage_group" NOT NULL,
	"osm_id" bigint NOT NULL,
	"name" text NOT NULL,
	"admin_level" smallint NOT NULL,
	"south" double precision NOT NULL,
	"west" double precision NOT NULL,
	"north" double precision NOT NULL,
	"east" double precision NOT NULL,
	"share" double precision NOT NULL,
	"length_m" integer NOT NULL,
	"covered_m" integer NOT NULL,
	"streets" integer NOT NULL,
	"streets_done" integer NOT NULL,
	"subareas" integer NOT NULL,
	"activities" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "coverage_area_athlete_id_group_osm_id_pk" PRIMARY KEY("athlete_id","group","osm_id")
);
--> statement-breakpoint
ALTER TABLE "activity_track" ADD CONSTRAINT "activity_track_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_track" ADD CONSTRAINT "activity_track_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_area" ADD CONSTRAINT "coverage_area_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_track_athlete_idx" ON "activity_track" USING btree ("athlete_id","start_time");