"""Starter exploration over the ingested corpus.

Run top to bottom, or a block at a time in an interactive console:

    set -a; . ../.env; set +a
    ./.venv/bin/python explore.py

Streams are read straight out of object storage. There is no export step and no
local copy: this is the same Parquet the services write.
"""

from conn import duck, streams_glob

con = duck()

# jsonb arrives from Postgres as text; this unpacks a flag array into rows.
FLAGS = "from_json(quality_flags, '[\"VARCHAR\"]')"

print("=== activities by sport ===")
con.sql("""
    SELECT sport,
           count(*)                          AS activities,
           round(sum(distance_m) / 1000, 1)  AS km,
           round(sum(duration_s) / 3600, 1)  AS hours,
           round(avg(avg_hr))                AS mean_hr
    FROM pg.public.activity
    GROUP BY sport
    ORDER BY hours DESC
""").show()

print("=== data quality flags ===")
con.sql(f"""
    SELECT flag, count(*) AS n
    FROM (SELECT unnest({FLAGS}) AS flag FROM pg.public.activity)
    GROUP BY flag ORDER BY n DESC
""").show()

# Why the flags matter: one hand-entered swim recorded as 50 hours accounts for
# well over half of all swim time in the corpus. Any load model that trusts the
# raw column inherits that error.
print("=== effect of excluding flagged durations (swimming) ===")
con.sql(f"""
    SELECT round(sum(duration_s) / 3600, 1)                                     AS raw_hours,
           round(sum(duration_s) FILTER (
             WHERE NOT list_contains({FLAGS}, 'implausible_duration')
           ) / 3600, 1)                                                          AS clean_hours
    FROM pg.public.activity
    WHERE sport = 'swimming'
""").show()

print("=== monthly training hours, last 18 months ===")
con.sql(f"""
    SELECT date_trunc('month', start_time)::DATE  AS month,
           count(*)                               AS sessions,
           round(sum(duration_s) / 3600, 1)       AS hours,
           round(sum(distance_m) / 1000)          AS km
    FROM pg.public.activity
    WHERE start_time > now() - INTERVAL 18 MONTH
      AND NOT list_contains({FLAGS}, 'implausible_duration')
    GROUP BY 1 ORDER BY 1
""").show()

print("=== channel coverage ===")
con.sql("""
    SELECT channel, count(*) AS activities
    FROM (SELECT unnest(from_json(channels, '["VARCHAR"]')) AS channel FROM pg.public.activity)
    GROUP BY channel ORDER BY activities DESC LIMIT 15
""").show()

# Streams: queried in place from object storage, joined to Postgres summaries.
print("=== heart-rate distribution across every stream ===")
con.sql(f"""
    SELECT (heart_rate::INT / 10)::INT * 10 AS hr_bucket,
           count(*)                          AS samples,
           repeat('#', (count(*) / 1500)::INT) AS bar
    FROM read_parquet('{streams_glob()}', union_by_name = true)
    WHERE heart_rate BETWEEN 80 AND 210
    GROUP BY 1 ORDER BY 1
""").show(max_rows=20)

print("=== biggest single sessions by moving time ===")
con.sql(f"""
    SELECT start_time::DATE AS date, sport, sub_sport,
           round(distance_m / 1000, 1)  AS km,
           round(moving_s / 60)         AS minutes,
           avg_hr, elev_gain_m          AS elev_m
    FROM pg.public.activity
    WHERE NOT list_contains({FLAGS}, 'implausible_duration')
    ORDER BY moving_s DESC LIMIT 10
""").show()
