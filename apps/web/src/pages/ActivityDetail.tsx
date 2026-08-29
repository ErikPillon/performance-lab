import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import uPlot from 'uplot';
import { api, type StreamPayload } from '../lib/api';
import { Chart, themeColor, useThemeVersion } from '../components/Chart';
import { Empty } from '../components/PmcChart';
import { Badge, Bar, ErrorNote, Loading, Panel, SportDot, Stat } from '../components/ui';
import * as f from '../lib/format';

/** One cursor across every chart on the page, so the traces read together. */
const SYNC = uPlot.sync('activity');

const TRACES = [
  { key: 'heart_rate', label: 'Heart rate', unit: 'bpm', color: '--bad', fill: false },
  { key: 'power_w', label: 'Power', unit: 'W', color: '--tsb', fill: false },
  { key: 'speed_mps', label: 'Speed', unit: 'km/h', color: '--ctl', fill: false, scale: 3.6 },
  // Elevation is an absolute altitude, not a magnitude: ranging from zero
  // flattens 200 m of rolling terrain into a straight line near the axis.
  { key: 'altitude_m', label: 'Elevation', unit: 'm', color: '--other', fill: true, fromData: true },
  { key: 'cadence', label: 'Cadence', unit: 'rpm', color: '--warn', fill: false },
];

const ZONE_ORDER = ['z1_recovery', 'z2_aerobic', 'z3_tempo', 'z4_threshold', 'z5_vo2max'];
const ZONE_LABEL: Record<string, string> = {
  z1_recovery: 'Z1 Recovery',
  z2_aerobic: 'Z2 Aerobic',
  z3_tempo: 'Z3 Tempo',
  z4_threshold: 'Z4 Threshold',
  z5_vo2max: 'Z5 VO₂max',
};
const ZONE_COLOR: Record<string, string> = {
  z1_recovery: '#64748b',
  z2_aerobic: 'var(--run)',
  z3_tempo: 'var(--warn)',
  z4_threshold: 'var(--atl)',
  z5_vo2max: 'var(--bad)',
};

export function ActivityDetail() {
  const { id = '' } = useParams();
  const detail = useQuery({ queryKey: ['activity', id], queryFn: () => api.activity(id) });
  const streams = useQuery({
    queryKey: ['streams', id],
    queryFn: () => api.streams(id, 2000),
    enabled: !!detail.data?.activity.hasStreams,
  });

  if (detail.isError) return <ErrorNote error={detail.error} />;
  if (!detail.data) return <Loading what="activity" />;

  const { activity: a, load } = detail.data;
  const chosenLoad = load?.load as number | null | undefined;
  const chosenMethod = (load?.loadMethod as string) ?? 'none';
  const gapSecPerKm = load?.gapSecPerKm as number | null | undefined;

  // jsonb preserves insertion order, not zone order, so the keys are sorted
  // and coloured by name rather than by position.
  const rawZones = (load?.timeInZones ?? null) as Record<string, number> | null;
  const zones = rawZones
    ? ZONE_ORDER.filter((z) => rawZones[z] != null).map((z) => [z, rawZones[z]!] as const)
    : [];
  const zoneTotal = zones.reduce((sum, [, v]) => sum + v, 0);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div>
        <Link to="/activities" style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none' }}>
          ← All activities
        </Link>
        <h1 style={{ margin: '8px 0 2px', fontSize: 20, fontWeight: 600, textTransform: 'capitalize' }}>
          <SportDot sport={a.sport} />
          {a.subSport && a.subSport !== 'generic' ? a.subSport.replace(/_/g, ' ') : a.sport}
        </h1>
        <div style={{ color: 'var(--muted)', fontSize: 13, display: 'flex', gap: 10, alignItems: 'center' }}>
          {f.dateTime(a.startTime, a.tzOffsetMin)}
          {a.device && <span style={{ color: 'var(--faint)' }}>· {a.device}</span>}
          {a.qualityFlags.map((flag) => (
            <Badge key={flag} tone={flag.startsWith('implausible') ? 'bad' : 'warn'}>
              {flag.replace(/_/g, ' ')}
            </Badge>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        <Stat label="Duration" value={f.duration(a.durationS)} hint={a.movingS ? `${f.duration(a.movingS)} moving` : undefined} />
        <Stat label="Distance" value={f.km(a.distanceM)} unit="km" />
        <Stat
          label={a.sport === 'cycling' ? 'Avg speed' : 'Pace'}
          value={f.rate(a.sport, a.distanceM, a.durationS, a.qualityFlags).value}
          unit={f.rate(a.sport, a.distanceM, a.durationS, a.qualityFlags).unit}
          hint={gapSecPerKm ? `${f.pace(gapSecPerKm)} /km grade-adjusted` : undefined}
        />
        <Stat label="Avg HR" value={a.avgHr ?? '—'} unit={a.avgHr ? 'bpm' : ''} hint={a.maxHr ? `max ${a.maxHr}` : undefined} />
        <Stat label="Elevation" value={f.num(a.elevGainM)} unit="m" />
        <Stat
          label="Load"
          value={f.num(chosenLoad, 1)}
          hint={f.LOAD_METHOD_LABEL[chosenMethod] ?? chosenMethod}
          color="var(--accent)"
        />
      </div>

      <Panel title="Streams" subtitle={
        streams.data
          ? `${streams.data.sample_count.toLocaleString()} samples, drawn at ${streams.data.returned.toLocaleString()} points`
          : undefined
      }>
        {!a.hasStreams ? (
          <Empty>This activity has no per-sample data — the file recorded a summary only.</Empty>
        ) : streams.isLoading ? (
          <Loading what="streams" />
        ) : (
          <StreamCharts payload={streams.data!} />
        )}
      </Panel>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        {zoneTotal > 0 && (
          <Panel title="Time in zones">
            <div style={{ display: 'grid', gap: 10 }}>
              {zones.map(([zone, seconds]) => (
                <div key={zone}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                    <span>{ZONE_LABEL[zone] ?? zone}</span>
                    <span className="num" style={{ color: 'var(--muted)' }}>
                      {f.duration(seconds)} · {Math.round((seconds / zoneTotal) * 100)}%
                    </span>
                  </div>
                  <Bar fraction={seconds / zoneTotal} color={ZONE_COLOR[zone] ?? 'var(--other)'} />
                </div>
              ))}
            </div>
          </Panel>
        )}

        <Panel title="Load models" subtitle="every model that could be computed for this session">
          <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
            <Row label="Heart-rate TSS" value={f.num(load?.hrTss as number, 1)} chosen={chosenMethod === 'hr_tss'} />
            <Row label="Pace TSS" value={f.num(load?.paceTss as number, 1)} chosen={chosenMethod === 'pace_tss'} />
            <Row label="Power TSS" value={f.num(load?.powerTss as number, 1)} chosen={chosenMethod === 'power_tss'} />
            <Row label="Swim TSS" value={f.num(load?.swimTss as number, 1)} chosen={chosenMethod === 'swim_tss'} />
            <Row label="TRIMP" value={f.num(load?.trimp as number, 1)} />
            <Row label="Intensity factor" value={f.num(load?.intensityFactor as number, 3)} />
            <Row label="Efficiency factor" value={f.num(load?.efficiencyFactor as number, 4)} />
            <Row
              label="Aerobic decoupling"
              value={load?.decouplingPct != null ? `${f.num(load.decouplingPct as number, 1)}%` : '—'}
              hint={
                load?.decouplingPct != null
                  ? (load.decouplingPct as number) < 5
                    ? 'well supported'
                    : (load.decouplingPct as number) < 10
                      ? 'moderate drift'
                      : 'ran out of aerobic support'
                  : undefined
              }
            />
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Row({ label, value, chosen, hint }: { label: string; value: string; chosen?: boolean; hint?: string }) {
  if (value === '—' && !chosen) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
      <span style={{ color: 'var(--muted)' }}>
        {label}
        {chosen && <span style={{ marginLeft: 6 }}><Badge tone="good">used</Badge></span>}
      </span>
      <span className="num" style={{ fontWeight: chosen ? 600 : 400 }}>
        {value}
        {hint && <span style={{ color: 'var(--faint)', fontWeight: 400, marginLeft: 6 }}>{hint}</span>}
      </span>
    </div>
  );
}

function StreamCharts({ payload }: { payload: StreamPayload }) {
  const themeVersion = useThemeVersion();
  const charts = useMemo(() => {
    const t = (payload.series.t_s ?? []).map((v) => (v ?? 0) as number);
    return TRACES.filter((trace) => payload.channels.includes(trace.key)).map((trace) => {
      const raw = payload.series[trace.key] ?? [];
      const values = raw.map((v) => (v == null ? null : v * (trace.scale ?? 1)));
      return { trace, data: [t, values] as uPlot.AlignedData };
    });
  }, [payload]);

  if (charts.length === 0) return <Empty>No chartable channels in this stream.</Empty>;

  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {charts.map(({ trace, data }, i) => (
        <div key={trace.key}>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 2 }}>
            {trace.label} <span style={{ color: 'var(--faint)' }}>({trace.unit})</span>
          </div>
          <Chart
            data={data}
            height={i === 0 ? 150 : 110}
            themeVersion={themeVersion}
            options={{
              cursor: {
                drag: { x: true, y: false },
                sync: { key: SYNC.key },
                points: { size: 5 },
              },
              legend: { show: false },
              scales: {
                x: { time: false },
                y: trace.fromData
                  ? {
                      range: (_u, min, max) => {
                        const pad = Math.max((max - min) * 0.1, 2);
                        return [min - pad, max + pad];
                      },
                    }
                  : {},
              },
              axes: [
                {
                  stroke: themeColor('--faint'),
                  grid: { stroke: themeColor('--grid'), width: 1 },
                  ticks: { stroke: themeColor('--grid') },
                  // Elapsed seconds read better as h:mm than as a raw count.
                  values: (_u, splits) =>
                    splits.map((s) => {
                      const m = Math.floor(s / 60);
                      return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : `${m}m`;
                    }),
                },
                {
                  stroke: themeColor('--faint'),
                  grid: { stroke: themeColor('--grid'), width: 1 },
                  ticks: { stroke: themeColor('--grid') },
                  size: 44,
                },
              ],
              series: [
                {},
                {
                  label: trace.label,
                  stroke: themeColor(trace.color),
                  width: 1.4,
                  fill: trace.fill ? `${themeColor(trace.color)}26` : undefined,
                  points: { show: false },
                  spanGaps: false,
                },
              ],
            }}
          />
        </div>
      ))}
    </div>
  );
}
