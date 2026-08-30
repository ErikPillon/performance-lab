# performance-lab

Self-hosted training analytics for triathlon — an alternative to TrainingPeaks,
aiming at the analytical depth of Runalyze.

**Status:** ingestion, training-load engine, read API and dashboard working
end to end against a 252-file corpus (2020–2025, 404,771 samples).

## Architecture

```
  upload / connector
         │
         ▼
  ┌─────────────┐   sha256, dedupe, blob store    ┌──────────┐
  │   ingest    │────────────────────────────────►│  MinIO   │  raw/  + streams/
  │  (Fastify)  │                                 └──────────┘
  └──────┬──────┘
         │ BullMQ job                             ┌──────────┐
         ▼                                        │  Redis   │
  ┌─────────────┐    POST /parse    ┌───────────┐ └──────────┘
  │   worker    │──────────────────►│ analytics │
  │  (BullMQ)   │◄──────────────────│ (FastAPI) │  fitparse → polars → Parquet
  └──────┬──────┘   summary + key   └───────────┘
         │
         ▼
  ┌─────────────┐
  │  Postgres   │  athlete, athlete_threshold, raw_file, activity,
  └─────────────┘  activity_load, athlete_daily
         ▲
         │                         ┌──────────┐
  ┌──────┴──────┐   /streams       │   web    │  Vite + React + uPlot
  │     api     │◄────────────────►│ (:3100)  │
  │   (:8003)   │  proxied to      └──────────┘
  └─────────────┘  analytics
```

Three queues, so a slow model can never block ingestion:

```
  parse ──► load ──► pmc (debounced 15s, collapses a 252-file import
                          into one fitness-model rebuild)
```

Python owns FIT decoding and the numeric work — the mature decoders live there,
and power-duration curves and critical-power modelling belong in numpy/polars,
not in the orchestration layer. TypeScript owns orchestration, the queue and the
domain schema. `lab/` imports the same Python modules the service runs, so
exploratory findings ship without a rewrite.

### Why raw bytes are kept

Every file that enters the system is stored immutably, content-addressed by
SHA-256, before anything is derived from it. Activities, streams and (later)
training-load metrics are all rebuildable from those bytes. When a load formula
or the parser improves, history is replayed locally — never re-fetched from a
vendor whose rate limits and retention are outside our control.

`activity.parser_version` records which parser produced each row, so a replay
can target only stale ones.

### Why thresholds are effective-dated

`athlete_threshold` is keyed by `effective_from`. FTP and LTHR drift over years,
so a TSS computed against today's FTP misrepresents a ride from 2021. Derived
metrics join to the threshold row in effect at the activity's start time.

### Why bad data is flagged, not rejected

Real training data is dirty. This corpus contains a genuine 750 m swim
hand-entered as 50 hours — 59% of all recorded swim time. Dropping it loses a
real session; trusting it hands a 50-hour swim to the load model. So rows are
kept verbatim and marked in `activity.quality_flags`, and load computation
filters on those flags.

Flags currently emitted:

| flag | meaning |
|---|---|
| `implausible_duration` | over 24 h; almost always a manual-entry error |
| `implausible_speed` | average speed beyond a generous per-sport ceiling |
| `implausible_distance` | over 1,000 km |
| `stream_distance_diverges` | session total and stream disagree by >2% |
| `nonmonotonic_time` | samples went backwards; device restarted mid-activity |
| `no_stream` | valid session carrying no record messages |

`stream_distance_diverges` matters for analysis: it fires on treadmill runs,
where Garmin rewrites the session total after user calibration but leaves the
per-record stream at the watch's accelerometer estimate. Pace read straight off
the stream is then wrong by up to 10% — it must be rescaled onto the session
distance.

## Training load

Load is reported on the TSS scale, where **100 = one hour at threshold**.

### Models

| model | applies to | needs |
|---|---|---|
| `hr_tss` | any sport | Banister TRIMP over HR reserve, integrated per second |
| `pace_tss` | running | grade-adjusted normalised pace vs threshold pace |
| `power_tss` | cycling, rowing | normalised power vs FTP |
| `swim_tss` | swimming | session pace vs critical swim speed (cubic) |
| `duration_estimate` | fallback | the athlete's own median load/hour for that sport |

Every applicable model is computed and stored for each activity; `load_method`
records which one was used for the headline number.

**Load is integrated per sample, not derived from average heart rate.** An
interval session and a steady run can share a mean HR and differ in load by
over 20%; averaging cannot tell them apart. Streams are resampled to 1 Hz first,
because Garmin smart recording samples irregularly (~7 s here) and every window
metric otherwise inherits that bias.

### Consistency over per-session precision

The default preference is heart-rate-first for every sport. Pace and power model
a single session better, but *switching model between sessions puts steps in the
fitness curve that no training explains*. On this corpus `pace_tss` scores 1.38×
`hr_tss` for the same runs, so a winter of treadmill work — scored by HR, since
treadmill distance is user-calibrated and the stream is not — would read as a
fitness collapse that never happened.

Run with `--preference precision` to take the best model per activity, the way
TrainingPeaks does. Both are recomputes, not re-ingests. `model_agreement`
stores the pace/HR ratio per activity so a mis-set threshold stays visible.

### Estimated load, kept visible

62% of this athlete's cycling volume (110 of 179 hours) has no heart-rate data.
Dropping it would understate chronic load badly, so those sessions are scored at
the athlete's own median load-per-hour for that sport — calibrated from the
sessions that *were* measured — and marked `duration_estimate` so the inference
never passes as measurement. Activities whose duration is known-wrong are marked
`excluded_implausible` and contribute neither load nor training time.

### Thresholds

`npm run recompute` estimates thresholds from the athlete's own mean-maximal
efforts when none exist. Estimates carry provenance and warnings:

- **max HR** — best 5 s mean-max, not the highest single sample (strap artefacts)
- **LTHR** — best 60 min mean-max HR; flagged if outside 80–92% of max HR
- **FTP** — best 20 min power × 0.95, suppressed below 3 power files
- **threshold pace** — best 30 min grade-adjusted running speed
- **CSS** — 10th percentile of session paces ≥400 m (includes rest, so conservative)
- **resting HR** — cannot be derived from activity files; defaults to 50 and says so

Thresholds are effective-dated and resolved **per field**. Correcting a value
appends a new dated entry rather than editing history, so a 2021 ride keeps
being scored against 2021 fitness — and because resolution is per field,
recording an FTP test does not blank the CSS measured three years earlier.
Taking the newest row wholesale did exactly that during development, silently
dropping pace-derived scoring from 193 activities.

Edit them at `/thresholds`, or via `POST /athletes/:id/thresholds`. Either way
the stored load is then scaled against superseded numbers until you recompute —
the UI says so rather than starting minutes of work implicitly.

### Fitness model

CTL (42-day) and ATL (7-day) exponentially weighted averages of daily load; form
is `ctl - atl` as of the *previous* day. Also computed: ramp rate, Foster
monotony and strain, and acute:chronic workload ratio.

Decay uses `1 - exp(-1/N)`, not the `2/(N+1)` a span-based EWMA gives. For a
42-day constant those are 0.0236 and 0.0465 — the span form decays about twice
as fast and produces a visibly different curve for identical training.

## Layout

| path | what |
|---|---|
| `packages/db` | Drizzle schema + migrations; owns the Postgres contract |
| `services/ingest-worker` | upload API, BullMQ parse worker, backfill CLI |
| `services/analytics` | FastAPI: FIT decode, load models, PMC, Parquet |
| `services/api` | read API, threshold writes, recompute control |
| `packages/jobs` | queue definitions shared by the API and the worker |
| `lab` | DuckDB exploration over the same Parquet, no export step |
| `apps/web` | dashboard: PMC, activity list, per-activity streams |
| `inputs` | local FIT corpus, gitignored |

## Running it

Ports are deliberately offset (5433 / 6380 / 9100) to coexist with the
`open-finance` stack on this machine.

### Everything in Docker

```bash
cp .env.example .env      # then set POSTGRES_PASSWORD and S3_SECRET_KEY
docker compose --profile apps up -d --build
npm run db:migrate        # first run only
```

Dashboard at **http://localhost:3100**. nginx serves the built SPA and proxies
`/api` to the API container, so the browser stays on one origin: no CORS, and no
API URL baked into the bundle — the same image runs on localhost, on the LAN box
and behind a public hostname.

Infra alone (`postgres`, `redis`, `minio`) comes up without the profile:
`npm run infra:up`. That is the mode to use while developing, with the services
run locally against it.

> **Native binaries and the lockfile.** `apps/web` declares
> `optionalDependencies` for rollup, lightningcss, Tailwind's oxide and esbuild
> across linux-x64, linux-arm64 and darwin-arm64. npm records only the variant
> matching the machine that ran `npm install` ([npm/cli#4828]), so a lockfile
> generated on a Mac fails the Linux image build on a missing native module.
> Declaring the targets puts them all in the lockfile; npm skips the ones that
> do not apply. Add a target here before building for a new architecture.

[npm/cli#4828]: https://github.com/npm/cli/issues/4828

### Local development

```bash
cp .env.example .env      # then set POSTGRES_PASSWORD and S3_SECRET_KEY
npm install
npm run infra:up
npm run db:migrate
```

Then, in four terminals:

```bash
cd services/analytics && python3 -m venv .venv && ./.venv/bin/pip install -e . && \
  set -a && . ../../.env && set +a && ./.venv/bin/uvicorn app.main:app --port 8001
```

```bash
set -a && . ./.env && set +a && npm run worker
```

```bash
set -a && . ./.env && set +a && npm run api
```

```bash
npm run web        # http://localhost:3100, proxying /api to :8003
```

Backfill a directory of FIT files. Re-running is free: ingestion is keyed on
content hash, so files already present are skipped without re-parsing.

```bash
npm run backfill -- ./inputs --athlete "Erik"
```

Then estimate thresholds and build the fitness model. New uploads are scored
automatically; this is for the initial bootstrap and for replaying after a model
change.

```bash
npm run recompute -- --athlete "Erik"
```

Watch progress:

```bash
curl -s localhost:8002/ingest/status | jq
```

## Tests

```bash
cd services/analytics && ./.venv/bin/python -m pytest tests -q
```

The Python suite runs against the real corpus in `inputs/` and skips when it is
absent. It asserts what an analytics pipeline must never do quietly: drop an
activity, mangle units, reorder samples, or silently accept impossible values.

```bash
npm -w @lab/ingest-worker test
```

## Dashboard

`docker compose --profile apps up -d` or `npm run web` → http://localhost:3100

- **Dashboard** — fitness/fatigue/form chart with daily load behind it, sport
  breakdown, heart-rate zone distribution, recent activities, current thresholds
- **Activities** — filterable, paginated list showing how each session was
  scored and any quality flags it carries
- **Activity** — synced heart rate / speed / elevation / cadence traces, time in
  zones, and every load model that could be computed with the chosen one marked
- **Curve** — mean-maximal duration curve per sport and metric, a recent window
  overlaid on all-time, and critical speed / D′ fitted from the aggregate
- **Thresholds** — what is currently in effect and where each value came from,
  an append-only editor, and a recompute control with progress and staleness

Two decisions worth knowing about:

**Charts are uPlot, not an SVG library.** The fitness series is ~2,000 daily
points and a single ride stream is thousands more; SVG charts allocate a DOM
node per point and stop being interactive well before that.

**Streams are downsampled server-side to ~1,500 points**, using bucketed
min/max rather than striding. Striding drops whichever samples fall between
strides, so a 30-second VO₂max interval can disappear from a heart-rate trace
entirely. Bucketing keeps each bucket's extremes, so peaks survive: on a
4,504-sample activity the reduction preserves min/max exactly and shifts the
mean by under 0.1 bpm, for a ~20 KB payload.

**Date ranges anchor to the last activity, not to today.** Anchoring to today
means an athlete who has not trained for months opens the dashboard to a chart
that is almost entirely flat decay.

## Not yet built

- Power-duration curve and critical power (the mean-max primitive exists in
  `app/streams.py`; the curve endpoint does not)
- VO2max estimation and race prediction
- Auth (Better Auth) and the coach↔athlete grant model — the API is currently
  unauthenticated and assumes a single athlete
- Route maps (MapLibre) on the activity view
- Upload from the browser; the upload endpoint still lives on the ingest worker
  rather than the API
- Strava connector (webhook-first) behind a Cloudflare Tunnel

## Known limitations

- **No power data.** `power_tss` is implemented and unit-tested but has never
  run against a real power meter file. Treat its first real numbers with
  suspicion.
- **Swim load uses session pace**, which includes rest between sets. HR is
  preferred for swimming as a result; lap-level parsing would let pace win.
- **The `duration_estimate` fallback assumes** no-HR sessions resemble measured
  ones for that sport. If the strap comes off mainly on hard group rides, those
  are systematically underestimated.
- **LTHR is estimated at 93% of max HR** for this athlete, above the usual band.
  A field test would settle it; every HR-derived load number scales with it.
