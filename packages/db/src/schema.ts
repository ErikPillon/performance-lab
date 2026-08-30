import {
  pgTable, pgEnum, uuid, text, integer, doublePrecision, timestamp, date,
  jsonb, index, uniqueIndex, smallint, primaryKey,
} from 'drizzle-orm/pg-core';

/**
 * Canonical sports. `other` is deliberate: the FIT spec has ~90 sport codes and
 * Garmin invents more, so anything unrecognised lands in `other` with the raw
 * value preserved in `activity.rawSport`. Never drop an activity for its sport.
 */
export const sportEnum = pgEnum('sport', [
  'running', 'cycling', 'swimming', 'rowing', 'walking',
  'hiking', 'skiing', 'strength', 'multisport', 'transition', 'other',
]);

export const sexEnum = pgEnum('sex', ['male', 'female', 'unspecified']);

export const sourceEnum = pgEnum('source', ['upload', 'strava', 'garmin', 'manual']);

/** raw_file lifecycle. `skipped` = parsed fine but carried no usable session. */
export const ingestStatusEnum = pgEnum('ingest_status', [
  'pending', 'parsing', 'parsed', 'skipped', 'failed',
]);

export const athlete = pgTable('athlete', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  sex: sexEnum('sex').notNull().default('unspecified'),
  birthDate: date('birth_date'),
  timezone: text('timezone').notNull().default('Europe/Zurich'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Effective-dated physiological thresholds.
 *
 * This table is why load metrics stay honest. FTP and LTHR drift over years, so
 * a TSS computed against today's FTP misrepresents a ride from 2021. Every
 * derived metric joins to the row in effect at the activity's start time:
 *   SELECT * FROM athlete_threshold
 *    WHERE athlete_id = $1 AND effective_from <= $2
 *    ORDER BY effective_from DESC LIMIT 1
 */
export const athleteThreshold = pgTable('athlete_threshold', {
  id: uuid('id').primaryKey().defaultRandom(),
  athleteId: uuid('athlete_id').notNull().references(() => athlete.id, { onDelete: 'cascade' }),
  effectiveFrom: date('effective_from').notNull(),
  maxHr: smallint('max_hr'),
  restHr: smallint('rest_hr'),
  /** Lactate threshold HR — the anchor for HR-based load. */
  lthr: smallint('lthr'),
  ftpWatts: smallint('ftp_watts'),
  /** Critical swim speed, seconds per 100 m. */
  cssSecPer100m: doublePrecision('css_sec_per_100m'),
  /** Threshold running pace, seconds per km. */
  thresholdPaceSecPerKm: doublePrecision('threshold_pace_sec_per_km'),
  weightKg: doublePrecision('weight_kg'),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('athlete_threshold_athlete_from_uq').on(t.athleteId, t.effectiveFrom),
]);

/**
 * Immutable, content-addressed record of every byte that entered the system.
 * Blobs live in object storage at `blobKey`; this table is the index.
 *
 * Everything downstream is derived and rebuildable from here. When a parser or
 * a load formula improves, we replay these — we never re-fetch from a vendor.
 */
export const rawFile = pgTable('raw_file', {
  id: uuid('id').primaryKey().defaultRandom(),
  athleteId: uuid('athlete_id').notNull().references(() => athlete.id, { onDelete: 'cascade' }),
  /** SHA-256 of the file bytes; makes re-ingestion idempotent and free. */
  sha256: text('sha256').notNull(),
  source: sourceEnum('source').notNull().default('upload'),
  originalFilename: text('original_filename'),
  contentType: text('content_type'),
  byteSize: integer('byte_size').notNull(),
  blobKey: text('blob_key').notNull(),
  status: ingestStatusEnum('status').notNull().default('pending'),
  error: text('error'),
  attempts: smallint('attempts').notNull().default(0),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  parsedAt: timestamp('parsed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('raw_file_athlete_sha_uq').on(t.athleteId, t.sha256),
  index('raw_file_status_idx').on(t.status),
]);

export const activity = pgTable('activity', {
  id: uuid('id').primaryKey().defaultRandom(),
  athleteId: uuid('athlete_id').notNull().references(() => athlete.id, { onDelete: 'cascade' }),
  rawFileId: uuid('raw_file_id').references(() => rawFile.id, { onDelete: 'set null' }),

  source: sourceEnum('source').notNull().default('upload'),
  /** Vendor's own id (Strava activity id, Garmin summaryId) when there is one. */
  sourceId: text('source_id'),

  /**
   * Cross-source dedupe: `{sport}:{start_time truncated to the minute}:{duration in whole minutes}`.
   * The same session arriving as a Garmin FIT and again over the Strava API
   * collapses onto one row rather than double-counting training load.
   */
  dedupeKey: text('dedupe_key').notNull(),

  sport: sportEnum('sport').notNull(),
  subSport: text('sub_sport'),
  /** Untouched sport value from the source, including unmapped numeric codes. */
  rawSport: text('raw_sport'),

  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  /** Offset in minutes at the activity's location; keeps "was this a morning run?" answerable. */
  tzOffsetMin: smallint('tz_offset_min'),

  durationS: doublePrecision('duration_s'),
  movingS: doublePrecision('moving_s'),
  distanceM: doublePrecision('distance_m'),
  elevGainM: doublePrecision('elev_gain_m'),
  avgHr: smallint('avg_hr'),
  maxHr: smallint('max_hr'),
  avgPowerW: smallint('avg_power_w'),
  maxPowerW: smallint('max_power_w'),
  avgCadence: doublePrecision('avg_cadence'),
  calories: integer('calories'),
  device: text('device'),

  /** Object-storage key of the Parquet stream file; null when there were no records. */
  streamsKey: text('streams_key'),
  sampleCount: integer('sample_count').notNull().default(0),
  /** Channels actually present, e.g. ["heart_rate","power","position_lat"]. */
  channels: jsonb('channels').$type<string[]>().notNull().default([]),

  /**
   * Data-quality markers from the parser, e.g. `implausible_duration`,
   * `stream_distance_diverges`, `nonmonotonic_time`, `no_stream`.
   *
   * Dirty data is kept rather than rejected — the corpus contains a real 750 m
   * swim hand-entered as 50 hours — so load computation filters on these
   * instead of trusting every row. Empty is the common case.
   */
  qualityFlags: jsonb('quality_flags').$type<string[]>().notNull().default([]),

  /** Parser version that produced this row; lets a replay target stale rows only. */
  parserVersion: text('parser_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('activity_athlete_dedupe_uq').on(t.athleteId, t.dedupeKey),
  index('activity_athlete_start_idx').on(t.athleteId, t.startTime),
  index('activity_sport_idx').on(t.athleteId, t.sport, t.startTime),
]);

/**
 * Derived training load, one row per activity.
 *
 * Separate from `activity` because these are outputs of a model, not facts
 * about the session. A better load model means dropping and rebuilding this
 * table; the activity rows and the raw blobs behind them never move.
 */
export const activityLoad = pgTable('activity_load', {
  activityId: uuid('activity_id')
    .primaryKey()
    .references(() => activity.id, { onDelete: 'cascade' }),
  athleteId: uuid('athlete_id').notNull().references(() => athlete.id, { onDelete: 'cascade' }),
  /** Denormalised from `activity` so the daily rollup is a single-table scan. */
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),

  /** The headline number, on the TSS scale: 100 = one hour at threshold. */
  load: doublePrecision('load'),
  /**
   * Which model produced `load`: power_tss | pace_tss | swim_tss | hr_tss |
   * duration_estimate | none. Recorded so a chart can always say how a number
   * was arrived at, and so estimates can be visually distinguished.
   */
  loadMethod: text('load_method').notNull().default('none'),

  /** Every model that could be computed, kept for comparison. */
  trimp: doublePrecision('trimp'),
  hrTss: doublePrecision('hr_tss'),
  paceTss: doublePrecision('pace_tss'),
  powerTss: doublePrecision('power_tss'),
  swimTss: doublePrecision('swim_tss'),

  intensityFactor: doublePrecision('intensity_factor'),
  npWatts: doublePrecision('np_w'),
  variabilityIndex: doublePrecision('variability_index'),
  ngpMps: doublePrecision('ngp_mps'),
  gapSecPerKm: doublePrecision('gap_sec_per_km'),
  swimPaceSecPer100m: doublePrecision('swim_pace_sec_per_100m'),
  /** Effort per heartbeat; the clearest single "is fitness improving" trend. */
  efficiencyFactor: doublePrecision('efficiency_factor'),
  /** Drift in effort-per-heartbeat, first half vs second. Durability signal. */
  decouplingPct: doublePrecision('decoupling_pct'),
  /**
   * pace_tss / hr_tss where both were computable. Systematically far from 1.0
   * means threshold pace and LTHR disagree about what threshold is, which
   * rescales every load number derived from them.
   */
  modelAgreement: doublePrecision('model_agreement'),
  /** Seconds per HR zone, keyed z1_recovery..z5_vo2max. */
  timeInZones: jsonb('time_in_zones').$type<Record<string, number>>(),

  calcVersion: text('calc_version').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('activity_load_athlete_start_idx').on(t.athleteId, t.startTime),
  index('activity_load_method_idx').on(t.loadMethod),
]);

/**
 * Daily rollup and the fitness/fatigue model.
 *
 * Every calendar day gets a row, including rest days — those are when fatigue
 * decays, so a series that skipped them would misstate form badly.
 */
export const athleteDaily = pgTable('athlete_daily', {
  athleteId: uuid('athlete_id').notNull().references(() => athlete.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),

  load: doublePrecision('load').notNull().default(0),
  durationS: doublePrecision('duration_s').notNull().default(0),
  distanceM: doublePrecision('distance_m').notNull().default(0),
  activities: smallint('activities').notNull().default(0),

  /** Chronic training load: 42-day exponentially weighted average. "Fitness". */
  ctl: doublePrecision('ctl').notNull().default(0),
  /** Acute training load: 7-day equivalent. "Fatigue". */
  atl: doublePrecision('atl').notNull().default(0),
  /** Training stress balance, ctl - atl as of the previous day. "Form". */
  tsb: doublePrecision('tsb').notNull().default(0),

  /** CTL gained over the trailing 7 days; sustained high values precede injury. */
  rampRate: doublePrecision('ramp_rate').notNull().default(0),
  weeklyLoad: doublePrecision('weekly_load').notNull().default(0),
  /** Foster monotony: weekly mean over weekly SD. High means undifferentiated training. */
  monotony: doublePrecision('monotony').notNull().default(0),
  strain: doublePrecision('strain').notNull().default(0),
  /** Acute:chronic workload ratio. Above ~1.5 is the commonly cited risk zone. */
  acwr: doublePrecision('acwr').notNull().default(0),

  calcVersion: text('calc_version').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.athleteId, t.date] }),
  index('athlete_daily_date_idx').on(t.date),
]);

/**
 * Per-activity mean-maximal curve: the best average a channel sustained over
 * each window length.
 *
 * Stored per activity and aggregated with MAX at query time rather than scanned
 * on demand. A five-year athlete curve would otherwise re-read every Parquet
 * file in the store — 35 s on this corpus and growing linearly — where this is
 * an indexed grouped aggregate over a few tens of thousands of rows.
 *
 * `sport` and `startTime` are denormalised from `activity` so the hot query
 * needs no join.
 */
export const activityCurve = pgTable('activity_curve', {
  activityId: uuid('activity_id')
    .notNull()
    .references(() => activity.id, { onDelete: 'cascade' }),
  athleteId: uuid('athlete_id').notNull().references(() => athlete.id, { onDelete: 'cascade' }),
  sport: sportEnum('sport').notNull(),
  startTime: timestamp('start_time', { withTimezone: true }).notNull(),
  /** power_w | speed_mps | gap_mps | heart_rate */
  metric: text('metric').notNull(),
  durationS: integer('duration_s').notNull(),
  /** Best average over any window of `durationS`, in the metric's own units. */
  value: doublePrecision('value').notNull(),
}, (t) => [
  primaryKey({ columns: [t.activityId, t.metric, t.durationS] }),
  index('activity_curve_lookup_idx').on(t.athleteId, t.sport, t.metric, t.durationS),
  index('activity_curve_time_idx').on(t.athleteId, t.startTime),
]);

export type Athlete = typeof athlete.$inferSelect;
export type RawFile = typeof rawFile.$inferSelect;
export type Activity = typeof activity.$inferSelect;
export type NewActivity = typeof activity.$inferInsert;
export type ActivityLoad = typeof activityLoad.$inferSelect;
export type NewActivityLoad = typeof activityLoad.$inferInsert;
export type AthleteDaily = typeof athleteDaily.$inferSelect;
export type ActivityCurve = typeof activityCurve.$inferSelect;
