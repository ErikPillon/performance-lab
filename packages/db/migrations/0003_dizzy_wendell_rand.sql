CREATE TABLE "activity_curve" (
	"activity_id" uuid NOT NULL,
	"athlete_id" uuid NOT NULL,
	"sport" "sport" NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"metric" text NOT NULL,
	"duration_s" integer NOT NULL,
	"value" double precision NOT NULL,
	CONSTRAINT "activity_curve_activity_id_metric_duration_s_pk" PRIMARY KEY("activity_id","metric","duration_s")
);
--> statement-breakpoint
ALTER TABLE "activity_curve" ADD CONSTRAINT "activity_curve_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_curve" ADD CONSTRAINT "activity_curve_athlete_id_athlete_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athlete"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_curve_lookup_idx" ON "activity_curve" USING btree ("athlete_id","sport","metric","duration_s");--> statement-breakpoint
CREATE INDEX "activity_curve_time_idx" ON "activity_curve" USING btree ("athlete_id","start_time");