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

### ☑ 2a. Lazy queue connections

**Why.** `packages/jobs` opened a Redis connection at module load, so importing
anything that transitively reached it connected — which hung the API test suite
until the pure validation rules were split into their own module. Module-load
side effects are the underlying problem.

**Done.** Queues and the connection are created on first use. `connection()`,
`parseQueue()` and friends are memoised accessors rather than eagerly-built
objects; call sites gained `()`, which is the point — a connection is now
visible where it is opened instead of hiding in an import.

`REDIS_URL` is read at call time too, so a script can set it after importing
and an unset value fails with a usable stack rather than during someone else's
import.

Shutdown is bounded: `closeQueues()` races the graceful `QUIT` against a 2 s
timer and then drops the socket. A clean quit needs a server to answer it, and
when Redis is already gone the old path waited for a reply that was never
coming — a process handling SIGTERM would hang until something killed it
harder.

`packages/jobs` now has tests, and the first one is the regression guard:
importing the module must leave `isConnected()` false. It deliberately needs no
running Redis — if it ever does, the invariant is already broken.

---

## Tier 1 — Make the training legible

The dashboard currently answers "how much have I trained". These make it answer
"how am I actually going".

### ☑ 3. Power/pace duration curve

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

**Done.** Curves are computed per activity during the load job — the stream is
already resampled and in memory there — and stored in `activity_curve`. A
date-ranged athlete curve is then a `DISTINCT ON` over an indexed table rather
than a scan of every Parquet file, which would have been ~35 s and growing.
`/curve` overlays a recent window against all-time, with critical speed and D′
fitted from the aggregate.

Two data problems surfaced and are now handled:

*Vehicle contamination.* One activity holds 9+ m/s for 31 consecutive seconds
with smooth acceleration — a watch left recording on the way home, not a GPS
spike. Samples above a per-sport plausibility cap are excluded (not clipped —
clipping invents a best effort at exactly the cap), and the activity is noted.
The cap applies after grade adjustment too, since a gradient multiplier can push
a sample that passed the raw check back over it.

*GPS resolution.* Every sub-30-second best landed exactly on the cap, which is
what noise pinned against a ceiling looks like. Consumer GPS carries 1–3 m/s of
instantaneous error, so speed-derived curves now start at 30 s. Power and heart
rate are measured directly and start lower.

### ☑ 4. Route maps

**Why.** 160 of 252 activities carry GPS and none of it is visible. Also the
cheapest way to make the activity view feel finished.

**What.** MapLibre GL with a free tile source, route drawn from the `lat`/`lon`
channels already in the stream payload, cursor synced with the existing charts.

**Effort** small-medium. No new backend work — the data is already served.

**Done.** Leaflet, not MapLibre. The job is raster tiles and a polyline, which
Leaflet does in ~42 kB with no WebGL, no worker and no animation-frame
dependency; MapLibre's ~250 kB earns its place for vector basemaps, terrain or
rotation, none of which a route view uses.

The track is coloured by speed, heart rate or elevation in eight bands
(bucketed, so a 1,400-point track is eight layers rather than 1,400), the map
marker follows the chart cursor, and panel height adapts to the route's own
proportions — a 9.1 × 1.9 km out-and-back was wasting most of a fixed wide
panel.

The route is drawn from our own stored coordinates and renders with or without
tiles, so a firewalled or offline server still shows the track. Tiles default to
public OpenStreetMap, which means the viewed area is visible to that provider;
`VITE_MAP_TILES` points it at your own tile server.

### ☑ 5. Calendar / weekly view

**Why.** Triathletes plan and review in weeks. A reverse-chronological list
cannot show that this week is a recovery week, or that Tuesday is always the
missed session.

**What.** Week-per-row grid, sessions coloured by sport, weekly load and
duration totals, planned-vs-actual once #12 exists.

**Effort** medium.

### ☑ 6. Trend charts for efficiency factor and decoupling

**Why.** These are already computed per activity and only visible one session at
a time. In trend they are the clearest "is my aerobic fitness improving"
signal available without a lab — this athlete's EF went 0.0169 → 0.0203 between
mid-2024 and 2025 while average HR fell from 167 to 148, and nothing in the UI
shows that.

**What.** EF and decoupling over time, per sport, with a rolling median.

**Done.** `/trends` plots both metrics per sport: individual sessions as faint
dots, a rolling median as the line. Drawing both matters — the scatter is wide
enough that a line alone would imply a precision the data does not have.

On the real corpus the signal is larger than the backlog estimated. Running,
2024-06 to 2026-08:

| | start | end | change |
|---|---|---|---|
| Efficiency factor | 0.0161 | 0.0215 | **+34%** |
| Average heart rate | 165.5 | 136.0 bpm | **−17.8%** |
| Decoupling | 10.6% | 2.2% | **−79%** |

More effort per heartbeat at a much lower heart rate, and durability moving from
poor to well-supported. The page states that pairing in words above the charts,
because efficiency factor alone moves with terrain and pacing — it only means
something read against heart rate.

Two things worth recording:

- **Series are keyed on effort source, not just sport.** EF is `mean effort /
  mean HR`, and effort is watts with a power meter and grade-adjusted speed
  without — roughly sixty times apart. This corpus happens to be cleanly split
  (running all speed, cycling all power), so mixing them would have looked fine
  until one ride without a meter drew a 60× cliff that reads as fitness
  collapse.
- **The smoothing window is calendar time, not a count of sessions.** "The last
  9 activities" spans three weeks in a block and five months around an injury.
  Layoffs longer than the window break the line rather than being bridged: the
  median is well-defined on both sides of a gap, so nothing is null and a
  three-month break was otherwise drawn as three months of steady improvement.

**Effort** small. Data already existed in `activity_load`.

---

## Tier 2 — Before it leaves the laptop

### ◔ 7. Authentication and the athlete/coach model

**Why.** The API is unauthenticated and assumes a single athlete — it literally
picks the first row from `/athletes`. This is the largest architectural debt in
the project and it gets more expensive every feature that assumes it.

**What.** Better Auth mounted in a BFF, sessions in Postgres, and the
`coach_athlete_grant` model: athlete-initiated invites, scoped grants
(`training` / `wellness` / `location` separately), row-level security on
`athlete_id` so a forgotten WHERE clause cannot leak across athletes.

**Effort** large. **Blocks:** anything multi-user, and any public deployment.

**Done.** Better Auth mounted in the API, sessions in Postgres, email and
password. Every athlete-scoped route resolves access through one module, and a
structural test fails the build if a route is added without a guard — that audit
caught `/athletes/:id/zones` shipping unprotected the first time it ran.

The grant model works end to end: athlete-initiated invites with per-scope
consent, single-use codes that expire, and revocation. Scopes are a real
disclosure boundary rather than a label — a coach granted `training` alone
receives the effort traces with `lat`/`lon` stripped from the payload, and
adding `location` restores them. Coaches read; thresholds, recompute and
invites are owner-only. An athlete a caller cannot see returns 404, not 403, so
the API cannot be used to discover that an id exists.

**Still open — the deliberate remainder:**

- ☐ **Row-level security.** The centralised guard is the enforcement today. RLS
  was the belt-and-braces argument for putting sessions in the same database,
  and it still applies, but doing it properly means a request-scoped
  `SET LOCAL` inside a transaction on every read plus a non-superuser app role.
  Half-done RLS — one path that forgets to set the variable — is worse than
  none, so it is its own task rather than a rushed addition to this one.
- ☐ **Email verification and password reset.** Both need an SMTP route out of
  the house. Verification is off deliberately; on a LAN with one account it
  buys nothing, and it becomes necessary the moment this is publicly reachable.
- ☐ **Social sign-in.** A configuration change here plus a provider app; not a
  prerequisite for using this on your own network.
- ☐ **Session revocation UI.** Sessions are listed in the database but there is
  no "sign out everywhere".

### ☑ 8. Browser upload

**Why.** Importing is CLI-only. The upload endpoint also still lives on the
ingest worker rather than the API, which splits the public HTTP surface across
two services.

**Done.** The route is on `services/api` and `/upload` is a drag-and-drop view
with per-file progress and dedupe feedback.

Worth recording: this was worse than "split across two services". The edge proxy
only ever forwarded `/api/*`, and the worker's port is not published in
production at all — so the upload endpoint was **unreachable in any real
deployment**. Importing was CLI-only whether or not that was the intent.

`ingestBytes` and the object store moved into `packages/ingest`, shared by the
upload route and the backfill CLI. The S3 client is built on first use, same
lesson as [2a]: the old module read credentials at import and threw on a missing
key, so anything that transitively imported it failed before its own first line.
A pleasing consequence — a duplicate upload now returns without ever
constructing an S3 client, because the hash check short-circuits first.

Uploads go one file per request at concurrency 3, not one batch request. The
endpoint still accepts a batch, but then progress is only known for the whole
batch and a season of exports becomes one half-gigabyte request that fails as a
unit.

Rejections are per file: an unreadable file reports itself and the other
nineteen still land. Non-FIT parts are still drained before being rejected — an
unread multipart part blocks the ones behind it, so a single `.jpg` would
otherwise hang the rest of the upload.

**Effort** small. **Depends on** #7 for anything multi-user.

### ◔ 9. TLS and real deployment on 192.168.40.100

**What.** Caddy with a Cloudflare DNS-01 challenge for a real certificate on the
LAN IP — needed for Secure cookies and WebCrypto, and self-signed certs will
waste hours. Postgres streaming replica plus pgBackRest to the second box,
MinIO bucket replication, weekly encrypted offsite. Test a restore.

**Effort** medium. **Depends on** #7 before exposing anything.

**Done — TLS.** Caddy replaces nginx as the edge: it terminates TLS, serves the
built app and proxies `/api` on one origin. Which certificate it obtains is
decided entirely by `SITE_ADDRESS` — an IP or `*.localhost` address gets one
from Caddy's own internal CA with no account, token or internet, and a real
hostname triggers ACME over a DNS-01 challenge, which is the only option for a
server behind NAT.

Session cookies are now `__Secure-`, `HttpOnly`, `Secure`, `SameSite=Lax`.
Security headers include HSTS and a CSP tight enough to be worth having:
`script-src 'self'`, `connect-src 'self'`, and map tiles as the only permitted
third party. Verified against the real app — the map, charts and auth all work
under it.

**Done — CI/CD.** `npm run verify` runs locally exactly what GitHub Actions
runs, so a green local run means a green pipeline. CI typechecks, tests both
runtimes, and applies the migration chain to an empty Postgres — a migration
that has only ever run against a database it half-built is a migration that
breaks on the first real deploy. On `main` it publishes four images to GHCR.

Deployment is pull-based: a systemd timer on the server checks every five
minutes, migrates before swapping containers, and rolls back on its own if the
API does not pass its healthcheck. The server is behind NAT, so pulling needs
no inbound port, no tunnel, and no deploy key on a runner. `deploy/README.md`
is the runbook.

Also fixed on the way through: there was no `.dockerignore`, so the build
context was 1.3 GB — including `inputs/`, and including `apps/web/node_modules`,
78 MB of macOS-native binaries that `COPY apps/web` layered on top of a
correctly installed Linux tree. Context is now ~1 MB.

**Done — backup.** `scripts/backup.sh` snapshots Postgres (`pg_dump -Fc`) and
the MinIO volume nightly, keeps 14, and rsyncs to a second machine when
`BACKUP_REMOTE` is set. `scripts/restore.sh --verify` rehearses a restore into
a throwaway container and counts the rows, touching nothing live.

This is deliberately dumps rather than the streaming replica the original plan
called for. For 417 activities on a personal system, a nightly dump with a
rehearsed restore is worth more than continuous replication that is never
tested — the failure mode that actually happens is "the backups were empty
since March", not "we lost the last six hours".

**Still open:**

- ☐ **Set `BACKUP_REMOTE`.** Until the second box exists the snapshots sit on
  the disk they protect, which defends against deleting the wrong row and
  against nothing else.
- ☐ **Encrypted offsite.** LAN replication survives a dead SSD, not a burst
  pipe or a burglary. `age` or `restic` to object storage.
- ☐ **Streaming replication**, if the recovery point objective ever needs to be
  tighter than "last night". Not yet worth the operational weight.

---

## Tier 3 — Analytical depth

### ◔ 10. Critical power, critical swim speed, VO₂max and race prediction

**Why.** Runalyze's signature features and the reason to prefer this over a
spreadsheet.

**What.** Two-parameter CP/W′ model from the duration curve, CSS from swim
bests, VO₂max estimate with trend, race prediction (Riegel / VDOT / critical
speed) with a confidence range.

**Depends on** #3. **Effort** medium.

**Partly done.** The two-parameter model (`D = CS·t + D′`) is implemented and
fitted over 2–20 minutes; the same algebra gives critical power from a power
curve. On this data critical speed comes out at 4:35/km against an
independently-estimated threshold pace of 4:27/km — two methods within 8 s/km,
which is a reassuring cross-check. VO₂max and race prediction remain.

### ◔ 11. Zone distribution over time and polarisation index

**Why.** Current zone distribution is a single all-time aggregate. The
interesting question is whether the *shape* is drifting — this athlete is at
65/26/5/3/1, heavily Z1-weighted, and whether that is deliberate is invisible.

**Done — distribution over time.** A stacked column per month on `/trends`,
plus the three-zone rollup and a named shape. Current state across all sports:
**92% easy · 7% moderate · 1% hard over 422 h — pyramidal.**

The five stored zones collapse to three at the two physiological thresholds
(the 0.89 and 0.99 LTHR edges the analytics service already cuts at), which is
what makes "polarised" and "pyramidal" mean something rather than being
adjectives.

Column height tracks total recorded time, and this was the whole design
problem. Normalising every column to full height was the first attempt and it
lied: June 2024 holds 1.7 hours, nearly all of it hard, and full-height it
screamed a training shape one session cannot support — directly beside a
30-hour month drawn exactly the same size. Height is now how much a column is
entitled to claim.

**Deliberately not done — the numeric polarisation index.** The published
indices are a compressed function of the same three numbers, they disagree with
each other, and a scalar invites reading a decimal place of significance into a
coarse description of a training block. The shape is named instead, by
ordering:

| shape | ordering |
|---|---|
| pyramidal | easy > moderate > hard |
| polarised | easy > hard > moderate |
| threshold | not easy-dominated (under 60% easy) |

These need no citation and cannot be quietly wrong. If a numeric index is
wanted later it should arrive with a named source, not a formula from memory.

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
- ☐ **The daily rollup buckets by UTC date, the calendar by local date.** They
  agree on every activity in this dataset — all sessions are daytime in
  CET/CEST — but a session starting just after local midnight, or any training
  done after long-haul travel, would land on different days in the two views.
- ☐ **`tsx` runs the TypeScript services in production images.** It works and
  is pinned, but compiling to JavaScript would drop a build tool and its native
  esbuild binary from the runtime image — the same binary that broke the image
  build until the Dockerfiles moved to `npm ci`.
- ☐ **The corpus now contains one ride exported twice**, collapsed correctly by
  the dedupe key. Worth knowing that duplicates exist rather than assuming one
  file is one session — a test encoded that assumption and had to be corrected
  when the second export arrived.
- ☐ **Route tiles leak location to a third party by default.** Every map view
  tells the public OSM tile server roughly where you train. Self-hosting tiles
  closes it; `VITE_MAP_TILES` is already wired for that.
- ☐ **Grade adjustment inflates short efforts.** The 60 s grade-adjusted best
  reads 2:37/km against 3:22/km raw — a 30% uplift from climbing. That is GAP
  doing its job, but it makes the short end of the running curve read faster
  than any pace actually run.
- ☐ **Treadmill pace needs rescaling onto session distance** before it is used
  for anything. Flagged as `stream_distance_diverges`; currently those
  activities just fall through to HR.
