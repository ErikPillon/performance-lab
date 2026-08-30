import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type uPlot from 'uplot';
import { api, type CurvePoint } from '../lib/api';
import { Chart, themeColor, useThemeVersion } from '../components/Chart';
import { Empty } from '../components/PmcChart';
import { Badge, ErrorNote, Loading, Panel, Stat } from '../components/ui';
import * as f from '../lib/format';

/**
 * Mean-maximal (duration) curve.
 *
 * The best average sustained over every window length, aggregated across every
 * activity. Read left to right it is a fitness signature: the left end is
 * anaerobic capacity, the right end aerobic endurance, and the bend between
 * them is roughly threshold.
 *
 * Two windows are drawn together because the absolute numbers matter less than
 * whether this season is above or below the athlete's best.
 */

const METRIC_LABEL: Record<string, string> = {
  gap_mps: 'Grade-adjusted pace',
  speed_mps: 'Pace',
  power_w: 'Power',
  heart_rate: 'Heart rate',
};

/** Metrics displayed as pace rather than as their stored unit. */
const AS_PACE = new Set(['gap_mps', 'speed_mps']);

const RECENT = [
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 182 },
  { label: 'Last 12 months', days: 365 },
];

function niceDuration(seconds: number | null | undefined): string {
  // uPlot's log axis emits null for minor ticks it wants left unlabelled.
  if (seconds == null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

export function Curve({ athleteId }: { athleteId: string }) {
  const themeVersion = useThemeVersion();
  const [sport, setSport] = useState('running');
  const [metric, setMetric] = useState<string | undefined>(undefined);
  const [window, setWindow] = useState(RECENT[0]!);

  const sports = useQuery({ queryKey: ['curveSports', athleteId], queryFn: () => api.curveSports(athleteId) });
  const summary = useQuery({ queryKey: ['summary', athleteId], queryFn: () => api.summary(athleteId) });

  // Recent windows anchor to the last activity, not to today, or an athlete
  // between blocks compares their best against an empty period.
  const anchor = summary.data?.totals.last ? new Date(summary.data.totals.last) : new Date();
  const from = new Date(anchor.getTime() - window.days * 86_400_000).toISOString().slice(0, 10);

  const allTime = useQuery({
    queryKey: ['curve', athleteId, sport, metric, 'all'],
    queryFn: () => api.curve(athleteId, { sport, metric }),
  });
  const recent = useQuery({
    queryKey: ['curve', athleteId, sport, metric, window.days, from],
    queryFn: () => api.curve(athleteId, { sport, metric, from }),
    enabled: !!summary.data,
  });

  const isPace = AS_PACE.has(allTime.data?.metric ?? '');
  const unit = isPace ? '/km' : allTime.data?.metric === 'power_w' ? 'W' : 'bpm';

  const format = (value: number) => (isPace ? f.pace(1000 / value) : Math.round(value).toString());

  const data = useMemo<uPlot.AlignedData>(() => {
    const all = allTime.data?.points ?? [];
    if (all.length === 0) return [[], [], []];
    const durations = all.map((p) => p.durationS);
    const recentByDuration = new Map((recent.data?.points ?? []).map((p) => [p.durationS, p.value]));
    return [
      durations,
      all.map((p) => p.value),
      durations.map((d) => recentByDuration.get(d) ?? null),
    ];
  }, [allTime.data, recent.data]);

  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => {
    const grid = { stroke: themeColor('--grid', '#eee'), width: 1 };
    const axisText = themeColor('--faint', '#888');
    return {
      cursor: { drag: { x: true, y: false }, points: { size: 6 } },
      legend: { show: false },
      // Log x: efforts change fastest at the short end, and a linear axis
      // squeezes everything under five minutes into the first few pixels.
      scales: {
        // Range pinned to the ladder's own bounds: uPlot's log auto-range
        // snaps to powers of ten, which pushes the 30s end off the plot and
        // takes its tick with it.
        x: { time: false, distr: 3, range: () => [25, 16000] as [number, number] },
      },
      axes: [
        {
          stroke: axisText,
          grid,
          ticks: grid,
          // Explicit ticks at durations athletes actually think in. A log axis
          // otherwise lands on decades and labels the chart 2m and 17m.
          splits: () => [30, 60, 300, 1200, 3600, 7200, 14400],
          // A log axis labels only decade boundaries unless told otherwise,
          // which is why 30s and 1m kept disappearing while 20m survived.
          filter: (_u, splits) => splits,
          values: (_u, splits) => splits.map(niceDuration),
        },
        {
          stroke: axisText,
          grid,
          ticks: grid,
          size: 56,
          values: (_u, splits) => splits.map((s) => (s == null ? '' : format(s))),
        },
      ],
      series: [
        { label: 'duration' },
        {
          label: 'All time',
          stroke: themeColor('--faint', '#999'),
          width: 2,
          dash: [4, 3],
          points: { show: false },
        },
        {
          label: window.label,
          stroke: themeColor('--accent', '#2563eb'),
          width: 2.5,
          fill: `${themeColor('--accent', '#2563eb')}1a`,
          points: { show: false },
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion, isPace, window.label]);

  if (allTime.isError) return <ErrorNote error={allTime.error} />;

  const available = allTime.data?.available ?? [];
  const critical = allTime.data?.critical;
  const best = (seconds: number): CurvePoint | undefined =>
    allTime.data?.points.find((p) => p.durationS === seconds);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel
        title="Duration curve"
        subtitle="Best average sustained over each window length, across every activity"
        right={
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Segmented
              options={(sports.data?.sports ?? []).filter((s) => s.activities > 2).map((s) => ({
                value: s.sport,
                label: s.sport,
              }))}
              value={sport}
              onChange={(v) => {
                setSport(v);
                setMetric(undefined);
              }}
            />
            {available.length > 1 && (
              <Segmented
                options={available.map((m) => ({ value: m, label: METRIC_LABEL[m] ?? m }))}
                value={allTime.data?.metric ?? ''}
                onChange={setMetric}
              />
            )}
          </div>
        }
      >
        {allTime.isLoading ? (
          <Loading what="curve" />
        ) : (allTime.data?.points.length ?? 0) === 0 ? (
          <Empty>No curve data for {sport} yet — recompute to build it.</Empty>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
              <Legend color="var(--faint)" dashed label="All time" />
              <Legend color="var(--accent)" label={window.label} />
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                {RECENT.map((r) => (
                  <button
                    key={r.days}
                    onClick={() => setWindow(r)}
                    style={{
                      fontSize: 12,
                      padding: '2px 8px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      border: `1px solid ${r.days === window.days ? 'var(--accent)' : 'var(--border)'}`,
                      background: 'transparent',
                      color: r.days === window.days ? 'var(--accent)' : 'var(--muted)',
                    }}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            <Chart data={data} options={options} height={320} themeVersion={themeVersion} />
          </>
        )}
      </Panel>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {[60, 300, 1200, 3600].map((seconds) => {
          const point = best(seconds);
          return (
            <Stat
              key={seconds}
              label={`Best ${niceDuration(seconds)}`}
              value={point ? format(point.value) : '—'}
              unit={point ? unit : ''}
              hint={
                point ? (
                  <Link to={`/activities/${point.activityId}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                    {f.date(point.startTime, { year: 'numeric' })} →
                  </Link>
                ) : undefined
              }
            />
          );
        })}
      </div>

      {critical && (
        <Panel
          title={allTime.data?.metric === 'power_w' ? 'Critical power' : 'Critical speed'}
          subtitle="Two-parameter model fitted over 2–20 minute efforts"
        >
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--faint)' }}>
                {allTime.data?.metric === 'power_w' ? 'Critical power' : 'Critical speed'}
              </div>
              <div className="num" style={{ fontSize: 24, fontWeight: 600 }}>
                {format(critical.critical_speed_mps)}
                <span style={{ fontSize: 13, color: 'var(--muted)' }}> {unit}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                The pace theoretically sustainable indefinitely — in practice roughly an hour.
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--faint)' }}>
                D′ (anaerobic reserve)
              </div>
              <div className="num" style={{ fontSize: 24, fontWeight: 600 }}>
                {Math.round(critical.d_prime_m)}
                <span style={{ fontSize: 13, color: 'var(--muted)' }}> m</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>
                Distance available above critical speed before it is spent.
              </div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              <Badge tone={critical.r_squared > 0.97 ? 'good' : 'warn'}>
                fit r² {critical.r_squared.toFixed(3)} · {critical.points} points
              </Badge>
            </div>
          </div>

          {summary.data?.thresholds?.thresholdPaceSecPerKm && isPace && (
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--muted)' }}>
              Your threshold pace is set to{' '}
              <strong className="num">{f.pace(summary.data.thresholds.thresholdPaceSecPerKm)}/km</strong>, and this
              curve independently puts critical speed at{' '}
              <strong className="num">{format(critical.critical_speed_mps)}/km</strong>. Two methods agreeing is a
              good sign; a wide gap means one of them needs a look.
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 14, borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }} />
      {label}
    </span>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            fontSize: 12,
            padding: '3px 9px',
            borderRadius: 6,
            cursor: 'pointer',
            textTransform: 'capitalize',
            border: `1px solid ${o.value === value ? 'var(--accent)' : 'var(--border)'}`,
            background: o.value === value ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
            color: o.value === value ? 'var(--accent)' : 'var(--muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
