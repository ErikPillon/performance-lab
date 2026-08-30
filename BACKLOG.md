# Backlog

Ordered by strategic value, not by size. The ordering principle: **make the
numbers trustworthy, then make them legible, then make them shareable.** A
beautiful chart of a load model scaled against a threshold nobody has verified
is worse than no chart, because it invites decisions.

Status legend: ☐ not started · ◔ in progress · ☑ done

---

## Tier 0 — Trust the numbers

Nothing below this line is worth building until the numbers the dashboard shows
can be relied on.

### ☑ 1. Threshold management in the UI

**Why first.** Every HR-derived load number scales with LTHR, and the current
value (178) was auto-estimated at 93% of max HR — outside the usual 80–92% band
and explicitly flagged as suspect by the estimator. Resting HR is a hardcoded
default of 50 that cannot be derived from activity files at all. Correcting
either currently means hand-writing SQL. Until this exists, the whole dashboard
is provisional.

**What.** Read and write `athlete_threshold` from the UI, respecting its
effective-dating: correcting a value inserts a new dated row rather than editing
history, so a 2021 ride keeps being scored against 2021 fitness. Show the
estimator's provenance and warnings alongside each field. Trigger a recompute
when values change.

**Depends on** nothing. **Effort** small.

**Done.** `/thresholds` in the dashboard: an effective-values panel showing
where each number was resolved from, a form that appends a dated entry, and the
full history with deletes. Validation rejects slipped decimals and impossible
relationships (LTHR above max HR would make heart-rate reserve negative);
out-of-band values are advised on rather than blocked.

Building it surfaced a design flaw worth recording. Threshold resolution took
the newest row wholesale, so entering an FTP test blanked every field that row
left empty — on this data it silently dropped `pace_tss` from 193 activities.
Resolution is now **per field**: each value carries forward from the most recent
entry that set it, which is what thresholds actually are, independent
measurements taken at different times. Effective-dating is unchanged.

### ☑ 2. Recompute as a first-class operation

**Why.** Load and the fitness model are derived and disposable by design — that
is the point of keeping raw bytes. But replaying them is currently a CLI
invocation, which means the derived data silently goes stale whenever a
threshold or a model changes.

**What.** A `recompute` queue job covering load → calibration → PMC, an API
endpoint to enqueue it, progress visible in the UI, and a staleness indicator
when `calc_version` on stored rows is behind the running code.

**Depends on** nothing. Naturally paired with #1.

**Done.** A `recompute` queue with phase-and-count progress, `POST` and `GET`
endpoints, and a button in the UI that polls only while work is running.
Staleness compares stored `calc_version` against what the analytics service
reports today, so a moved load model is visible rather than silent. The CLI and
the dashboard call the same `recomputeAthlete`, so they cannot drift.

Queue definitions moved to `packages/jobs`, shared by the API and the worker —
the API needed to enqueue, and one definition of each queue's name, payload and
retry policy means a producer and a consumer cannot disagree about them.

---

### ☐ 2a. Lazy queue connections

**Why.** `packages/jobs` opens a Redis connection at module load, so importing
anything that transitively reaches it connects — which hung the API test suite
until the pure validation rules were split into their own module. Module-load
side effects are the underlying problem.

**What.** Create queues and the connection on first use.

**Effort** small.

---

## Tier 1 — Make the training legible

The dashboard currently answers "how much have I trained". These make it answer
"how am I actually going".

### ☐ 3. Power/pace duration curve

**Why.** The single most-loved chart in this category, and the foundation for
critical power, critical swim speed and race prediction. The mean-max primitive
already exists (`services/analytics/app/streams.py`), so the modelling is
mostly done.

**What.** Best sustained effort for every duration from 1 s to 4 h, per sport.
Rolling 90-day against all-time so improvement is visible. Needs a precomputed
table — scanning every Parquet file per request will not stay fast.

**Effort** medium. **Watch out for:** this is the first feature that needs a
cross-activity aggregate, so it forces a decision about where derived
aggregates live.

### ☐ 4. Route maps

**Why.** 160 of 252 activities carry GPS and none of it is visible. Also the
cheapest way to make the activity view feel finished.

**What.** MapLibre GL with a free tile source, route drawn from the `lat`/`lon`
channels already in the stream payload, cursor synced with the existing charts.

**Effort** small-medium. No new backend work — the data is already served.

### ☐ 5. Calendar / weekly view

**Why.** Triathletes plan and review in weeks. A reverse-chronological list
cannot show that this week is a recovery week, or that Tuesday is always the
missed session.

**What.** Week-per-row grid, sessions coloured by sport, weekly load and
duration totals, planned-vs-actual once #12 exists.

**Effort** medium.

### ☐ 6. Trend charts for efficiency factor and decoupling

**Why.** These are already computed per activity and only visible one session at
a time. In trend they are the clearest "is my aerobic fitness improving"
signal available without a lab — this athlete's EF went 0.0169 → 0.0203 between
mid-2024 and 2025 while average HR fell from 167 to 148, and nothing in the UI
shows that.

**What.** EF and decoupling over time, per sport, with a rolling median.

**Effort** small. Data already exists in `activity_load`.

---

## Tier 2 — Before it leaves the laptop

### ☐ 7. Authentication and the athlete/coach model

**Why.** The API is unauthenticated and assumes a single athlete — it literally
picks the first row from `/athletes`. This is the largest architectural debt in
the project and it gets more expensive every feature that assumes it.

**What.** Better Auth mounted in a BFF, sessions in Postgres, and the
`coach_athlete_grant` model: athlete-initiated invites, scoped grants
(`training` / `wellness` / `location` separately), row-level security on
`athlete_id` so a forgotten WHERE clause cannot leak across athletes.

**Effort** large. **Blocks:** anything multi-user, and any public deployment.

### ☐ 8. Browser upload

**Why.** Importing is CLI-only. The upload endpoint also still lives on the
ingest worker rather than the API, which splits the public HTTP surface across
two services.

**What.** Move the upload route to `services/api`, add a drag-and-drop view with
per-file progress and dedupe feedback ("already imported").

**Effort** small. **Depends on** #7 for anything multi-user.

### ☐ 9. TLS and real deployment on 192.168.40.100

**What.** Caddy with a Cloudflare DNS-01 challenge for a real certificate on the
LAN IP — needed for Secure cookies and WebCrypto, and self-signed certs will
waste hours. Postgres streaming replica plus pgBackRest to the second box,
MinIO bucket replication, weekly encrypted offsite. Test a restore.

**Effort** medium. **Depends on** #7 before exposing anything.

---

## Tier 3 — Analytical depth

### ☐ 10. Critical power, critical swim speed, VO₂max and race prediction

**Why.** Runalyze's signature features and the reason to prefer this over a
spreadsheet.

**What.** Two-parameter CP/W′ model from the duration curve, CSS from swim
bests, VO₂max estimate with trend, race prediction (Riegel / VDOT / critical
speed) with a confidence range.

**Depends on** #3. **Effort** medium.

### ☐ 11. Zone distribution over time and polarisation index

**Why.** Current zone distribution is a single all-time aggregate. The
interesting question is whether the *shape* is drifting — this athlete is at
65/26/5/3/1, heavily Z1-weighted, and whether that is deliberate is invisible.

**Effort** small.

### ☐ 12. Season planning: races, blocks, planned vs actual

**Why.** This is TrainingPeaks' actual moat, and the thing a coach relationship
is built around.

**What.** A/B/C races, periodisation blocks, coach-assigned workouts, compliance
scoring against what was executed.

**Effort** large. **Depends on** #7.

### ☐ 13. Wellness: HRV, resting HR, sleep, weight

**Why.** Closes the loop on readiness, and gives resting HR a real source
instead of the current hardcoded 50 (see #1).

**What.** Manual entry plus import. Overlay on the PMC.

**Effort** medium.

---

## Tier 4 — More data in

### ☐ 14. Strava connector

**What.** Webhook-first with polling reconciliation, Cloudflare Tunnel for
public HTTPS ingress, encrypted token storage with proactive refresh, a
persistent rate-limit bucket and resumable backfill cursor.

**Note the constraint.** Strava's API agreement restricts displaying one user's
data to any other user, which conflicts directly with the coach feature. Keep
Strava as a convenience mirror for the athlete's own view; athlete-uploaded FIT
stays the canonical path.

**Effort** medium-large. **Depends on** #9 for the public callback.

### ☐ 15. Garmin and Apple Watch

**Garmin.** The official Connect Developer Program is business-use with manual
approval and new sign-ups appeared to be on hold as of 2026 — do not design
around it. FIT export is the reliable path. Never store another user's Garmin
password.

**Apple Watch.** No server API exists; it needs a companion iOS app reading
HealthKit. That is a separate project, not a connector.

---

## Known correctness debts

Small, but each one is a wrong number rather than a missing feature.

- ☐ **Confirm LTHR by field test.** Estimated at 93% of max HR and flagged in
  the UI. Measured on a single activity, correcting LTHR 178 → 172 moved its
  load by **+16.7%** — this is the single highest-value correction available.
  Enter it at `/thresholds`, then recompute.
- ☐ **Measure resting HR.** Currently a hardcoded 50; not derivable from
  activity files. Editable at `/thresholds`.
- ☐ **`power_tss` has never run against real data.** Implemented and unit-tested
  but this corpus has one power file. Treat first real numbers with suspicion.
- ☐ **Swim load uses session pace**, which includes rest between sets. HR is
  preferred as a result; lap-level parsing would let pace win.
- ☐ **The `duration_estimate` fallback assumes** no-HR sessions resemble
  measured ones for that sport. 62% of cycling volume is estimated this way. If
  the strap comes off mainly on hard rides, those are systematically low.
- ☐ **Treadmill pace needs rescaling onto session distance** before it is used
  for anything. Flagged as `stream_distance_diverges`; currently those
  activities just fall through to HR.
