"""Explore training load and the fitness model.

    set -a; . ../.env; set +a
    ./.venv/bin/python training_load.py

Reads the same Postgres tables and Parquet streams the services write, and
imports the same load functions the analytics service runs — so anything worked
out here transfers without a rewrite.
"""

import sys

from conn import duck

sys.path.insert(0, "../services/analytics")

con = duck()

print("=== how each activity was scored ===")
con.sql("""
    SELECT al.load_method,
           count(*)                                              AS activities,
           round(avg(al.load), 1)                                AS avg_load,
           round(sum(a.duration_s) / 3600, 1)                    AS hours,
           round(avg(al.load / (a.duration_s / 3600)), 1)        AS load_per_hour
    FROM pg.public.activity_load al
    JOIN pg.public.activity a ON a.id = al.activity_id
    WHERE a.duration_s > 600
    GROUP BY 1 ORDER BY hours DESC
""").show()

print("=== load by sport, and how much of it is inferred rather than measured ===")
con.sql("""
    SELECT a.sport,
           count(*)                                                          AS activities,
           round(sum(al.load))                                               AS total_load,
           round(100.0 * count(*) FILTER (
             WHERE al.load_method = 'duration_estimate') / count(*))         AS pct_estimated
    FROM pg.public.activity_load al
    JOIN pg.public.activity a ON a.id = al.activity_id
    GROUP BY 1 ORDER BY total_load DESC NULLS LAST
""").show()

print("=== fitness, fatigue and form: month ends ===")
con.sql("""
    SELECT date, round(ctl, 1) AS fitness, round(atl, 1) AS fatigue,
           round(tsb, 1) AS form, round(weekly_load) AS weekly,
           round(monotony, 2) AS monotony, round(acwr, 2) AS acwr
    FROM pg.public.athlete_daily
    WHERE date = (date_trunc('month', date) + INTERVAL 1 MONTH - INTERVAL 1 DAY)::DATE
      AND (ctl > 1 OR weekly_load > 0)
    ORDER BY date DESC LIMIT 18
""").show(max_rows=20)

print("=== hardest weeks, and whether the ramp was risky ===")
con.sql("""
    SELECT date, round(weekly_load) AS weekly, round(ctl, 1) AS fitness,
           round(ramp_rate, 1) AS ramp, round(acwr, 2) AS acwr,
           CASE WHEN acwr > 1.5 THEN 'spike'
                WHEN ramp_rate > 8 THEN 'steep ramp' ELSE '' END AS flag
    FROM pg.public.athlete_daily
    ORDER BY weekly_load DESC LIMIT 10
""").show()

print("=== time in heart-rate zones, last 12 months ===")
con.sql("""
    SELECT zone, round(sum(seconds) / 3600, 1) AS hours,
           round(100.0 * sum(seconds) / sum(sum(seconds)) OVER ()) AS pct
    FROM (
      SELECT unnest(json_keys(time_in_zones))              AS zone,
             unnest(json_extract(time_in_zones, '$.*'))::INT AS seconds
      FROM pg.public.activity_load
      WHERE time_in_zones IS NOT NULL
        AND start_time > (SELECT max(start_time) FROM pg.public.activity_load) - INTERVAL 12 MONTH
    ) GROUP BY zone ORDER BY zone
""").show()

print("=== aerobic decoupling: durability on long sessions ===")
con.sql("""
    SELECT a.start_time::DATE AS date, a.sport,
           round(a.duration_s / 60)          AS minutes,
           round(a.distance_m / 1000, 1)     AS km,
           al.decoupling_pct,
           CASE WHEN al.decoupling_pct < 5 THEN 'well supported'
                WHEN al.decoupling_pct < 10 THEN 'moderate drift'
                ELSE 'ran out of aerobic support' END AS reading
    FROM pg.public.activity_load al
    JOIN pg.public.activity a ON a.id = al.activity_id
    WHERE al.decoupling_pct IS NOT NULL AND a.duration_s > 3600
    ORDER BY a.start_time DESC LIMIT 12
""").show()

print("=== efficiency factor trend: speed per heartbeat, by quarter ===")
con.sql("""
    SELECT date_trunc('quarter', a.start_time)::DATE AS quarter,
           count(*)                                  AS runs,
           round(avg(al.efficiency_factor), 4)       AS ef,
           round(avg(a.avg_hr))                      AS avg_hr
    FROM pg.public.activity_load al
    JOIN pg.public.activity a ON a.id = al.activity_id
    WHERE al.efficiency_factor IS NOT NULL AND a.sport = 'running'
    GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1 DESC LIMIT 10
""").show()
