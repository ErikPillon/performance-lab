import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type uPlot from 'uplot';
import { api, type TrendPointRow } from '../lib/api';
import { Chart, themeColor, useThemeVersion } from '../components/Chart';
import { Empty } from '../components/PmcChart';
import { Badge, ErrorNote, Loading, Panel, Stat } from '../components/ui';
import { ZoneDistribution } from '../components/ZoneDistribution';
import { compareEnds, rollingMedian, withGapBreaks, type TrendPoint } from '../lib/trends';
import * as f from '../lib/format';

/**
 * Aerobic fitness over time.
 *
 * Efficiency factor is effort per heartbeat, and aerobic decoupling is how far
 * that drifts between the first and second half of a session. Both were already
 * computed per activity and visible only one session at a time, which is the
 * one view in which neither says anything: a single EF number is meaningless
 * without the months either side of it.
 *
 * Individual sessions are drawn as faint dots and the rolling median as the
 * bold line. Showing both matters — the scatter is wide enough that a line on
 * its own would imply a precision the underlying data does not have.
 */

const SMOOTHING = [
  { label: '3 weeks', halfWindowDays: 10 },
  { label: '6 weeks', halfWindowDays: 21 },
  { label: '3 months', halfWindowDays: 45 },
];

const EFFORT_LABEL: Record<string, string> = {
  power: 'power / HR',
  speed: 'pace / HR',
};

export function Trends({ athleteId }: { athleteId: string }) {
  const themeVersion = useThemeVersion();
  const [sport, setSport] = useState<string | undefined>(undefined);
  const [smoothing, setSmoothing] = useState(SMOOTHING[1]!);

  const trends = useQuery({
    queryKey: ['trends', athleteId, sport],
    queryFn: () => api.trends(athleteId, { sport }),
  });
  // Across every sport: zones are heart-rate based and comparable, and the
  // question "what shape is my training" is about all of it, not one discipline.
  const zoneTrend = useQuery({
    queryKey: ['zonesTrend', athleteId],
    queryFn: () => api.zonesTrend(athleteId, { bucket: 'month' }),
  });

  const available = trends.data?.available ?? [];
  // The API picks the sport with the most data when none is requested; mirror
  // that back into the control so the selection is visible.
  const activeSport = trends.data?.sport ?? sport ?? '';
  const group = trends.data?.groups[0];
  const points = group?.points ?? [];

  const ef = useMemo<TrendPoint[]>(
    () => points.map((p) => ({ x: Date.parse(p.startTime), y: p.efficiencyFactor })),
    [points],
  );
  const decoupling = useMemo<TrendPoint[]>(
    () => points.map((p) => ({ x: Date.parse(p.startTime), y: p.decouplingPct })),
    [points],
  );

  const efChange = useMemo(() => compareEnds(ef), [ef]);
  const decouplingNow = useMemo(() => compareEnds(decoupling), [decoupling]);
  const hrChange = useMemo(
    () => compareEnds(points.map((p) => ({ x: Date.parse(p.startTime), y: p.avgHr }))),
    [points],
  );

  if (trends.isError) return <ErrorNote error={trends.error} />;
  if (trends.isLoading) return <Loading what="trends" />;

  const sportPicker = (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <Segmented
        options={available.map((s) => ({ value: s.sport, label: s.sport }))}
        value={activeSport}
        onChange={setSport}
      />
      {group && <Badge tone="muted">{EFFORT_LABEL[group.effortSource] ?? group.effortSource}</Badge>}
    </div>
  );

  if (available.length === 0 || points.length === 0) {
    return (
      <Panel title="Aerobic trends" right={sportPicker}>
        <Empty>
          Nothing to plot yet. Efficiency factor and decoupling both need heart rate paired with a
          steady effort signal, and are only computed for sessions over 20 minutes.
        </Empty>
      </Panel>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <Stat
          label="Efficiency factor"
          value={efChange ? efChange.last.toPrecision(3) : '—'}
          unit={group?.unit ?? ''}
          hint={efChange ? `${signed(efChange.changePct)}% vs the start of this range` : undefined}
        />
        <Stat
          label="Average heart rate"
          value={hrChange ? Math.round(hrChange.last).toString() : '—'}
          unit="bpm"
          hint={hrChange ? `${signed(hrChange.changePct)}% over the same period` : undefined}
        />
        <Stat label="Sessions plotted" value={points.length.toString()} />
        <Stat
          label="Recent decoupling"
          value={decouplingNow ? decouplingNow.last.toFixed(1) : '—'}
          unit="%"
          hint="under 5% reads as well-supported"
        />
      </div>

      {/*
        The headline claim of this page, stated in words. A chart shows the
        shape; whether the shape is good news depends on what heart rate did at
        the same time, and that pairing is the whole signal.
      */}
      {efChange && hrChange && Math.abs(efChange.changePct) > 2 && (
        <Panel>
          <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
            Between {f.date(new Date(efChange.from), { year: 'numeric' })} and{' '}
            {f.date(new Date(efChange.to), { year: 'numeric' })}, efficiency factor moved{' '}
            <strong style={{ color: efChange.changePct > 0 ? 'var(--good)' : 'var(--bad)' }}>
              {signed(efChange.changePct)}%
            </strong>{' '}
            while average heart rate moved{' '}
            <strong className="num">{signed(hrChange.changePct)}%</strong>
            {efChange.changePct > 0 && hrChange.changePct < 0 ? (
              <> — more effort per heartbeat at a lower heart rate, which is an improving aerobic base.</>
            ) : efChange.changePct < 0 && hrChange.changePct > 0 ? (
              <> — less effort per heartbeat at a higher heart rate. Worth checking against fatigue,
                heat, or a change in what you were training.</>
            ) : (
              <>. Read the two together: efficiency factor alone moves with terrain and pacing.</>
            )}
          </div>
        </Panel>
      )}

      <Panel
        title="Efficiency factor"
        subtitle={`Effort per heartbeat — ${group?.unit ?? ''}. Higher is better.`}
        right={
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {sportPicker}
            <Segmented
              options={SMOOTHING.map((s) => ({ value: s.label, label: s.label }))}
              value={smoothing.label}
              onChange={(v) => setSmoothing(SMOOTHING.find((s) => s.label === v) ?? SMOOTHING[1]!)}
            />
          </div>
        }
      >
        <TrendChart
          series={ef}
          rows={points}
          halfWindowDays={smoothing.halfWindowDays}
          themeVersion={themeVersion}
          format={(v) => v.toPrecision(3)}
        />
      </Panel>

      {zoneTrend.data && (
        <Panel
          title="Training distribution"
          subtitle="Share of recorded time in each heart-rate zone, by month, across every sport"
        >
          <ZoneDistribution data={zoneTrend.data} />
        </Panel>
      )}

      <Panel
        title="Aerobic decoupling"
        subtitle="Drift in effort per heartbeat, first half of a session against the second. Lower is better."
      >
        <TrendChart
          series={decoupling}
          rows={points}
          halfWindowDays={smoothing.halfWindowDays}
          themeVersion={themeVersion}
          format={(v) => `${v.toFixed(1)}%`}
          reference={5}
        />
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          Only computed for sessions over 20 minutes — below that the two halves are too short to
          compare. {points.length - decoupling.filter((p) => p.y != null).length} of {points.length}{' '}
          sessions here have none.
        </div>
      </Panel>
    </div>
  );
}

function TrendChart({
  series,
  rows,
  halfWindowDays,
  themeVersion,
  format,
  reference,
}: {
  series: TrendPoint[];
  rows: TrendPointRow[];
  halfWindowDays: number;
  themeVersion: number;
  format: (v: number) => string;
  /** Draws a horizontal guide, e.g. the 5% decoupling threshold. */
  reference?: number;
}) {
  const data = useMemo<uPlot.AlignedData>(() => {
    // Break the line across layoffs before smoothing. The synthetic sample sits
    // in the middle of the gap, where a centred window finds nothing to take a
    // median of, so it stays null and uPlot lifts the pen.
    const sorted = withGapBreaks(series, { maxGapDays: halfWindowDays * 2 });
    const smoothed = rollingMedian(sorted, { halfWindowDays });
    const xs = sorted.map((p) => p.x / 1000);
    return [
      xs,
      sorted.map((p) => p.y),
      smoothed,
      reference != null ? xs.map(() => reference) : xs.map(() => null),
    ];
  }, [series, halfWindowDays, reference]);

  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => {
    const grid = { stroke: themeColor('--grid', '#eee'), width: 1 };
    const axisText = themeColor('--faint', '#888');
    const accent = themeColor('--accent', '#2563eb');
    return {
      cursor: { drag: { x: true, y: false }, points: { size: 5 } },
      legend: { show: false },
      axes: [
        { stroke: axisText, grid, ticks: grid },
        {
          stroke: axisText,
          grid,
          ticks: grid,
          size: 60,
          values: (_u, splits) => splits.map((v) => (v == null ? '' : format(v))),
        },
      ],
      series: [
        { label: 'date' },
        {
          label: 'Session',
          // Points only, no connecting line: consecutive sessions are not a
          // continuous quantity, and joining them draws a sawtooth that reads
          // as signal when it is entirely session-to-session variation.
          stroke: `${accent}66`,
          width: 0,
          points: { show: true, size: 4, stroke: `${accent}99`, fill: `${accent}44` },
        },
        {
          label: 'Rolling median',
          stroke: accent,
          width: 2.5,
          points: { show: false },
          // Breaks the line across training gaps rather than spanning them.
          spanGaps: false,
        },
        {
          label: 'Reference',
          stroke: themeColor('--faint', '#999'),
          width: 1,
          dash: [4, 4],
          points: { show: false },
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion, reference]);

  if (series.every((p) => p.y == null)) {
    return <Empty>No data for this metric in the selected sport.</Empty>;
  }

  return (
    <>
      <Chart data={data} options={options} height={280} themeVersion={themeVersion} />
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
        {rows.length} sessions · median over a centred {halfWindowDays * 2}-day window ·{' '}
        <Link to="/activities" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
          browse activities →
        </Link>
      </div>
    </>
  );
}

function signed(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}`;
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
