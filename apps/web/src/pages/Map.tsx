import L from 'leaflet';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type uPlot from 'uplot';
import { api, type CoverageAreaRow, type CoverageResponse, type MapGroup, type Sector } from '../lib/api';
import { decodePolyline } from '../lib/polyline';
import { Bar, ErrorNote, Loading, Panel } from '../components/ui';
import { Empty } from '../components/PmcChart';
import { Chart, themeColor, useThemeVersion } from '../components/Chart';
import { TILE_URL, darkTheme } from '../components/RouteMap';
import * as f from '../lib/format';

/**
 * The whole history on one map: a heatmap of every route, and how much of each
 * commune's street network those routes have covered.
 *
 * Both draw from the simplified tracks the load job stores — a few hundred
 * sessions arrive in one response well under a megabyte — onto a single
 * canvas, so hundreds of overlapping lines stay one surface rather than
 * hundreds of DOM nodes.
 */

type View = 'heatmap' | 'coverage';
type Period = 'all' | '365' | '90';

const GROUPS: { value: MapGroup; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'foot', label: 'On foot' },
  { value: 'bike', label: 'Cycling' },
];

const PERIODS: { value: Period; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '365', label: '12 months' },
  { value: '90', label: '90 days' },
];

export function MapPage({ athleteId }: { athleteId: string }) {
  const [view, setView] = useState<View>('heatmap');
  const [group, setGroup] = useState<MapGroup>('all');

  const controls = (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      <Segmented
        options={[{ value: 'heatmap', label: 'Heatmap' }, { value: 'coverage', label: 'Street coverage' }]}
        value={view}
        onChange={(v) => setView(v as View)}
      />
      <Segmented options={GROUPS} value={group} onChange={(v) => setGroup(v as MapGroup)} />
    </div>
  );

  return view === 'heatmap'
    ? <Heatmap athleteId={athleteId} group={group} controls={controls} />
    : <Coverage athleteId={athleteId} group={group} controls={controls} />;
}

/* ------------------------------------------------------------------------- */

function Heatmap({ athleteId, group, controls }: { athleteId: string; group: MapGroup; controls: React.ReactNode }) {
  const [period, setPeriod] = useState<Period>('all');
  const from = period === 'all' ? undefined
    : new Date(Date.now() - Number(period) * 86_400_000).toISOString().slice(0, 10);
  const tracks = useQuery({
    queryKey: ['tracks', athleteId, group, from],
    queryFn: () => api.tracks(athleteId, group, from),
  });
  const themeVersion = useThemeVersion();

  const decoded = useMemo(
    () => (tracks.data?.tracks ?? []).map((t) => ({ ...t, lines: t.parts.map((p) => decodePolyline(p)) })),
    [tracks.data],
  );
  const home = useMemo(() => densestBounds(decoded), [decoded]);
  const everything = useMemo(() => allBounds(decoded), [decoded]);
  const [fitAll, setFitAll] = useState(0);

  const draw = useCallback((renderer: L.Renderer) => {
    // Opacity falls as the count rises, so a street run once still shows and
    // one run two hundred times does not become a solid slab.
    const opacity = Math.max(0.18, Math.min(0.7, 3 / Math.sqrt(Math.max(decoded.length, 1))));
    return decoded.flatMap((t) => t.lines.map((line) => L.polyline(line, {
      renderer,
      color: sportColor(t.sport),
      weight: 2.5,
      opacity,
      interactive: false,
    })));
    // themeVersion: colours are read from the theme at draw time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoded, themeVersion]);

  const count = decoded.length;
  return (
    <Panel
      title="Heatmap"
      subtitle={tracks.data ? `${count} route${count === 1 ? '' : 's'} · the brighter a street, the more often you were on it` : undefined}
      right={controls}
      pad={false}
    >
      <div style={{ display: 'flex', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented options={PERIODS} value={period} onChange={(v) => setPeriod(v as Period)} />
        {everything && (
          <button onClick={() => setFitAll((n) => n + 1)} style={linkButton}>Show everywhere</button>
        )}
      </div>
      {tracks.isError ? <div style={{ padding: 16 }}><ErrorNote error={tracks.error} /></div>
        : tracks.isLoading ? <Loading what="routes" />
        : count === 0 ? <Empty>No GPS routes in this period.</Empty>
        : (
          <LayerMap
            height={620}
            draw={draw}
            bounds={fitAll ? everything : home}
            fitKey={`${group}-${period}-${fitAll}`}
          />
        )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------- */

function Coverage({ athleteId, group, controls }: { athleteId: string; group: MapGroup; controls: React.ReactNode }) {
  const queryClient = useQueryClient();
  const coverage = useQuery({
    queryKey: ['coverage', athleteId, group],
    queryFn: () => api.coverage(athleteId, group),
    // Poll only while a refresh is queued or running; a failed one stays put.
    refetchInterval: (q) => {
      const state = q.state.data?.refresh?.state;
      return state && state !== 'failed' ? 4000 : false;
    },
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshCoverage(athleteId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['coverage', athleteId] }),
  });
  const [selected, setSelected] = useState<number | null>(null);

  const areas = coverage.data?.areas ?? [];
  const active = areas.find((a) => a.osmId === selected) ?? areas[0] ?? null;

  if (coverage.isError) return <ErrorNote error={coverage.error} />;
  if (coverage.isLoading || !coverage.data) return <Loading what="coverage" />;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Panel
        title="Street coverage"
        subtitle="Share of each commune's streets your routes have passed along, from OpenStreetMap"
        right={controls}
      >
        <RefreshBar
          data={coverage.data}
          empty={areas.length === 0}
          onRefresh={() => refresh.mutate()}
          pending={refresh.isPending}
        />
        {refresh.isError && <ErrorNote error={refresh.error} />}
        {areas.length > 0 && (
          <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
            {areas.map((a) => (
              <AreaRow key={a.osmId} area={a} active={a.osmId === active?.osmId} onClick={() => setSelected(a.osmId)} />
            ))}
          </div>
        )}
      </Panel>
      {active && <AreaDetail athleteId={athleteId} group={group} area={active} />}
    </div>
  );
}

function RefreshBar({ data, empty, onRefresh, pending }: {
  data: CoverageResponse; empty: boolean; onRefresh: () => void; pending: boolean;
}) {
  const r = data.refresh;
  const p = r && typeof r.progress === 'object' ? r.progress : null;
  let status: string | null = null;
  if (r?.state === 'failed') status = `The last refresh failed: ${r.failedReason ?? 'unknown error'}`;
  else if (r?.state === 'delayed') status = 'A refresh is scheduled — it waits a few minutes after new activities arrive.';
  else if (r && p?.phase === 'computing') status = `Updating ${p.area ?? 'areas'} (${p.done + 1} of ${p.total})…`;
  else if (r) status = 'Finding the communes your routes pass through…';

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, color: 'var(--muted)' }}>
      <span style={{ flex: 1, minWidth: 200, lineHeight: 1.6 }}>
        {status ?? (empty
          ? 'Nothing computed yet. The first run downloads each commune\'s streets from OpenStreetMap, one request at a time — expect a few minutes.'
          : 'Updated automatically a few minutes after new activities.')}
      </span>
      {data.canRefresh && (!r || r.state === 'failed' || r.state === 'delayed') && (
        <button onClick={onRefresh} disabled={pending} style={primaryButton}>
          {pending ? 'Queuing…' : empty ? 'Compute coverage' : 'Refresh now'}
        </button>
      )}
    </div>
  );
}

function AreaRow({ area, active, onClick }: { area: CoverageAreaRow; active: boolean; onClick: () => void }) {
  const pct = area.lengthM ? area.coveredM / area.lengthM : 0;
  return (
    <button
      onClick={onClick}
      style={{
        display: 'grid', gridTemplateColumns: 'minmax(120px, 1.2fr) 2fr auto', gap: 12, alignItems: 'center',
        textAlign: 'left', padding: '8px 10px', borderRadius: 8, cursor: 'pointer', font: 'inherit',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent',
        color: 'var(--text)',
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {area.name}
      </span>
      <Bar fraction={pct} color="var(--accent)" />
      <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {(pct * 100).toFixed(1)}% · {f.km(area.coveredM)}/{f.km(area.lengthM)} km
      </span>
    </button>
  );
}

function AreaDetail({ athleteId, group, area }: { athleteId: string; group: MapGroup; area: CoverageAreaRow }) {
  const detail = useQuery({
    queryKey: ['coverageDetail', athleteId, group, area.osmId, area.computedAt],
    queryFn: () => api.coverageDetail(athleteId, area.osmId, group),
  });
  const themeVersion = useThemeVersion();
  const [streetFilter, setStreetFilter] = useState('');
  const [unfinished, setUnfinished] = useState(true);
  const [sectorKey, setSectorKey] = useState<string | null>(null);

  const d = detail.data;
  const sector = d?.sectors?.find((x) => x.key === sectorKey) ?? null;
  const draw = useCallback((renderer: L.Renderer) => {
    if (!d) return [];
    const faint = themeColor('--faint', '#9ca3af');
    const accent = themeColor('--accent', '#2563eb');
    return [
      ...d.area.outline.map((ring) => L.polyline(decodePolyline(ring), {
        renderer, color: themeColor('--muted', '#6b7280'), weight: 1.5, dashArray: '4 4', interactive: false,
      })),
      ...d.runs.uncovered.map((run) => L.polyline(decodePolyline(run), {
        renderer, color: faint, weight: 1.6, opacity: 0.7, interactive: false,
      })),
      ...d.runs.covered.map((run) => L.polyline(decodePolyline(run), {
        renderer, color: accent, weight: sector ? 2 : 3, opacity: sector ? 0.45 : 0.95, interactive: false,
      })),
      ...(sector ? sectorLayers(sector, renderer) : []),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, sector, themeVersion]);

  const bounds = useMemo<L.LatLngBoundsExpression>(
    () => [[area.south, area.west], [area.north, area.east]],
    [area],
  );

  const streets = useMemo(() => {
    if (!d) return [];
    const needle = streetFilter.trim().toLowerCase();
    return d.streets
      .filter((s) => !needle || s.name.toLowerCase().includes(needle))
      .filter((s) => !unfinished || s.covered_m / Math.max(s.length_m, 1) < d.done_fraction)
      .slice(0, 150);
  }, [d, streetFilter, unfinished]);

  const pct = area.lengthM ? (100 * area.coveredM) / area.lengthM : 0;
  return (
    <Panel
      title={area.name}
      subtitle={`${pct.toFixed(1)}% of ${f.km(area.lengthM)} km · ${area.streetsDone} of ${area.streets} named streets done · ${area.activities} activities`}
      pad={false}
    >
      {detail.isError ? <div style={{ padding: 16 }}><ErrorNote error={detail.error} /></div>
        : detail.isLoading || !d ? <Loading what="streets" />
        : (
          <>
            <LayerMap height={560} draw={draw} bounds={bounds} fitKey={`${area.osmId}-${group}`} />
            <Sectors
              group={group}
              sectors={d.sectors ?? []}
              selected={sectorKey}
              onSelect={(key) => setSectorKey((k) => (k === key ? null : key))}
            />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 0, borderTop: '1px solid var(--border)' }}>
              <section style={{ padding: 16, borderRight: '1px solid var(--border)' }}>
                <h3 style={h3}>Neighbourhoods</h3>
                {d.subareas.length === 0 ? (
                  <div style={{ fontSize: 13, color: 'var(--faint)' }}>OpenStreetMap has no neighbourhoods mapped here.</div>
                ) : (
                  <>
                    {d.subareas_approx && (
                      <div style={{ fontSize: 12, color: 'var(--faint)', marginBottom: 8, lineHeight: 1.5 }}>
                        No official boundaries exist here, so each street belongs to the nearest named
                        suburb or quarter.
                      </div>
                    )}
                    <div style={{ display: 'grid', gap: 6 }}>
                      {d.subareas.map((s) => (
                        <Ratio key={s.id} name={s.name} length={s.length_m} covered={s.covered_m} />
                      ))}
                    </div>
                  </>
                )}
              </section>
              <section style={{ padding: 16 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
                  <h3 style={{ ...h3, margin: 0, flex: 1 }}>Streets</h3>
                  <label style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 4, alignItems: 'center' }}>
                    <input type="checkbox" checked={unfinished} onChange={(e) => setUnfinished(e.target.checked)} />
                    unfinished only
                  </label>
                  <input
                    placeholder="Find a street"
                    value={streetFilter}
                    onChange={(e) => setStreetFilter(e.target.value)}
                    style={{ fontSize: 12, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', width: 140 }}
                  />
                </div>
                <div style={{ display: 'grid', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
                  {streets.map((s) => (
                    <Ratio key={s.name} name={s.name} length={s.length_m} covered={s.covered_m} />
                  ))}
                  {streets.length === 0 && <div style={{ fontSize: 13, color: 'var(--faint)' }}>No streets match.</div>}
                </div>
              </section>
            </div>
            <div style={{ fontSize: 11, color: 'var(--faint)', padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
              A street counts where a route passed within {d.tolerance_m} m, and as done at{' '}
              {Math.round(d.done_fraction * 100)}%. Streets and boundaries © OpenStreetMap contributors.
            </div>
          </>
        )}
    </Panel>
  );
}

/**
 * The stretches this area's routes repeat, found rather than drawn, and every
 * pass along the selected one.
 */
function Sectors({ group, sectors, selected, onSelect }: {
  group: MapGroup;
  sectors: Sector[];
  selected: string | null;
  onSelect: (key: string) => void;
}) {
  const sector = sectors.find((s) => s.key === selected) ?? null;
  return (
    <section style={{ padding: 16, borderTop: '1px solid var(--border)' }}>
      <h3 style={h3}>Sectors</h3>
      {group === 'all' ? (
        <div style={{ fontSize: 13, color: 'var(--faint)' }}>
          Sectors are per sport — choose On foot or Cycling.
        </div>
      ) : sectors.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--faint)' }}>
          Nothing here has been covered often enough yet: a sector needs the same stretch of at
          least 400 m in four or more activities.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: 'var(--faint)', marginBottom: 10, lineHeight: 1.5 }}>
            Found from where your routes repeat, in the direction you ran them. Each pass is timed
            between a gate at either end, so laps count separately and a detour does not count.
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {sectors.map((s) => (
              <button
                key={s.key}
                onClick={() => onSelect(s.key)}
                style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) repeat(4, minmax(64px, auto))', gap: 12,
                  alignItems: 'center', textAlign: 'left', padding: '7px 10px', borderRadius: 8,
                  cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'var(--text)',
                  border: `1px solid ${s.key === selected ? 'var(--warn)' : 'var(--border)'}`,
                  background: s.key === selected ? 'color-mix(in srgb, var(--warn) 10%, transparent)' : 'transparent',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <strong style={{ fontWeight: 600 }}>{s.name}</strong>
                  <span style={{ color: 'var(--muted)' }}> · {f.km(s.length_m, 2)} km</span>
                </span>
                <Metric label="passes" value={String(s.passes.length)} />
                <Metric label="best" value={f.raceTime(s.best_s)} />
                <Metric label="median" value={f.raceTime(s.median_s)} />
                <Metric
                  label="last"
                  value={f.raceTime(s.last_s)}
                  tone={s.last_s < s.median_s ? 'var(--good)' : s.last_s > s.median_s * 1.05 ? 'var(--bad)' : undefined}
                />
              </button>
            ))}
          </div>
          {sector && <SectorPasses sector={sector} group={group} />}
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ color: tone ?? 'var(--text)' }}>{value}</span>
      <span style={{ color: 'var(--faint)', marginLeft: 4 }}>{label}</span>
    </span>
  );
}

/**
 * Every pass, over time, and in a table fastest first.
 *
 * Raw pace answers "was I faster"; the columns beside it answer "was it a fair
 * comparison". Grade-adjusted pace matters for a sector with a climb in it,
 * and heart rate is there because the same pace at ten beats lower is the
 * better run — which is the question a repeated stretch of street is best
 * placed to answer.
 */
function SectorPasses({ sector, group }: { sector: Sector; group: MapGroup }) {
  const themeVersion = useThemeVersion();
  const onFoot = group === 'foot';
  const rate = (speed: number) => (onFoot ? 1000 / speed : speed * 3.6);
  const show = (speed: number | undefined) =>
    speed == null ? '—' : onFoot ? f.pace(1000 / speed) : `${(speed * 3.6).toFixed(1)}`;
  const unit = onFoot ? '/km' : 'km/h';

  const dated = sector.passes.filter((p) => p.at);
  const data = useMemo<uPlot.AlignedData>(() => [
    dated.map((p) => Date.parse(p.at!) / 1000),
    dated.map((p) => rate(p.speed_mps)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [sector.key, group]);

  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => {
    const grid = { stroke: themeColor('--grid', '#eee'), width: 1 };
    const axisText = themeColor('--faint', '#888');
    const warn = themeColor('--warn', '#d97706');
    return {
      legend: { show: false },
      cursor: { points: { size: 6 } },
      // Pace: smaller is faster, so the axis runs downwards and faster is higher.
      scales: { y: { dir: onFoot ? -1 : 1 } },
      axes: [
        { stroke: axisText, grid, ticks: grid },
        {
          stroke: axisText, grid, ticks: grid, size: 56,
          values: (_u, splits) => splits.map((v) => (v == null ? '' : onFoot ? f.pace(v) : v.toFixed(1))),
        },
      ],
      series: [
        {},
        { label: 'Pass', stroke: warn, width: 0, points: { show: true, size: 6, stroke: warn, fill: `${warn}66` } },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion, onFoot]);

  const fastest = [...sector.passes].sort((a, b) => a.elapsed_s - b.elapsed_s);
  return (
    <div style={{ marginTop: 14, display: 'grid', gap: 10 }}>
      {dated.length >= 2 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {onFoot ? 'Pace' : 'Speed'} on every pass{onFoot ? ' — faster is higher' : ''}
          </div>
          <Chart data={data} options={options} height={220} themeVersion={themeVersion} />
        </>
      )}
      <div style={{ maxHeight: 320, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr style={{ color: 'var(--faint)', textAlign: 'right' }}>
              <th style={{ ...cell, textAlign: 'left' }}>date</th>
              <th style={cell}>time</th>
              <th style={cell}>{onFoot ? 'pace' : 'speed'} {unit}</th>
              <th style={cell}>grade-adj.</th>
              <th style={cell}>avg HR</th>
              <th style={cell}>climb</th>
            </tr>
          </thead>
          <tbody>
            {fastest.map((p, i) => (
              <tr key={`${p.activity_id}-${p.at}`} style={{ textAlign: 'right', borderTop: '1px solid var(--border)' }}>
                <td style={{ ...cell, textAlign: 'left' }}>
                  <Link to={`/activities/${p.activity_id}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                    {p.at ? f.date(p.at, { year: 'numeric' }) : 'activity'}
                  </Link>
                  {i === 0 && <span style={{ color: 'var(--good)', marginLeft: 6 }}>best</span>}
                </td>
                <td style={cell}>{f.raceTime(p.elapsed_s)}</td>
                <td style={cell}>{show(p.speed_mps)}</td>
                <td style={cell}>{show(p.gap_speed_mps)}</td>
                <td style={cell}>{p.avg_hr ? Math.round(p.avg_hr) : '—'}</td>
                <td style={cell}>{p.gain_m != null ? `${Math.round(p.gain_m)} m` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function sectorLayers(sector: Sector, renderer: L.Renderer): L.Layer[] {
  const line = decodePolyline(sector.polyline);
  const warn = themeColor('--warn', '#d97706');
  const start = line[0]!;
  const end = line[line.length - 1]!;
  return [
    L.polyline(line, { renderer, color: warn, weight: 6, opacity: 0.95, interactive: false }),
    L.circleMarker(start, { renderer, radius: 6, color: '#fff', weight: 2, fillColor: themeColor('--good', '#059669'), fillOpacity: 1 }),
    L.circleMarker(end, { renderer, radius: 6, color: '#fff', weight: 2, fillColor: themeColor('--bad', '#dc2626'), fillOpacity: 1 }),
  ];
}

const cell: React.CSSProperties = { padding: '5px 6px', fontWeight: 400 };

function Ratio({ name, length, covered }: { name: string; length: number; covered: number }) {
  const frac = length ? covered / length : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 90px 92px', gap: 10, alignItems: 'center', fontSize: 12 }}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      <Bar fraction={frac} color="var(--accent)" />
      <span style={{ color: 'var(--muted)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(frac * 100)}% · {f.km(length, length < 1000 ? 2 : 1)} km
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

/**
 * A Leaflet map whose layers are redrawn from a callback.
 *
 * The map is created once; layers are swapped when `draw` changes, and the
 * view is refitted only when `fitKey` changes — so a theme switch recolours
 * the lines without throwing away where the reader had panned to.
 */
function LayerMap({ height, draw, bounds, fitKey }: {
  height: number;
  draw: (renderer: L.Renderer) => L.Layer[];
  bounds: L.LatLngBoundsExpression | null;
  fitKey: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const renderer = useRef<L.Renderer | null>(null);
  const group = useRef<L.LayerGroup | null>(null);
  const tiles = useRef<L.TileLayer | null>(null);
  const themeVersion = useThemeVersion();

  useEffect(() => {
    if (!host.current) return;
    const instance = L.map(host.current, { zoomControl: true, zoomSnap: 0, preferCanvas: true });
    map.current = instance;
    renderer.current = L.canvas({ padding: 0.5 });
    group.current = L.layerGroup().addTo(instance);
    return () => {
      instance.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    tiles.current?.remove();
    tiles.current = L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
      className: darkTheme() ? 'map-tiles-dark' : undefined,
    }).addTo(instance);
    tiles.current.bringToBack();
  }, [themeVersion]);

  useEffect(() => {
    if (!group.current || !renderer.current) return;
    group.current.clearLayers();
    for (const layer of draw(renderer.current)) group.current.addLayer(layer);
  }, [draw]);

  useEffect(() => {
    if (map.current && bounds) map.current.fitBounds(bounds, { padding: [16, 16] });
    // Refit on a new subject, not on every render that rebuilds `bounds`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  return <div ref={host} style={{ height, width: '100%' }} />;
}

/** The busiest 0.05° cell and its neighbours: where you usually are. */
function densestBounds(tracks: { lines: [number, number][][] }[]): L.LatLngBoundsExpression | null {
  const cells = new Map<string, number>();
  const size = 0.05;
  for (const t of tracks) {
    for (const line of t.lines) {
      for (const [lat, lon] of line) {
        const key = `${Math.floor(lat / size)}:${Math.floor(lon / size)}`;
        cells.set(key, (cells.get(key) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  let count = 0;
  for (const [key, n] of cells) if (n > count) { best = key; count = n; }
  if (!best) return null;
  const [i, j] = best.split(':').map(Number) as [number, number];
  return [[(i - 1) * size, (j - 1) * size], [(i + 2) * size, (j + 2) * size]];
}

function allBounds(tracks: { lines: [number, number][][] }[]): L.LatLngBoundsExpression | null {
  let s = 90, w = 180, n = -90, e = -180;
  for (const t of tracks) for (const line of t.lines) for (const [lat, lon] of line) {
    if (lat < s) s = lat;
    if (lat > n) n = lat;
    if (lon < w) w = lon;
    if (lon > e) e = lon;
  }
  return s <= n ? [[s, w], [n, e]] : null;
}

function sportColor(sport: string): string {
  const variable = f.SPORT_COLOR[sport]?.match(/var\((--[^)]+)\)/)?.[1] ?? '--other';
  return themeColor(variable, '#888');
}

function Segmented({ options, value, onChange }: {
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
            fontSize: 12, padding: '3px 9px', borderRadius: 6, cursor: 'pointer',
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

const h3: React.CSSProperties = { margin: '0 0 10px', fontSize: 13, fontWeight: 600 };

const primaryButton: React.CSSProperties = {
  fontSize: 12, padding: '4px 11px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--accent)', background: 'transparent', color: 'var(--accent)',
};

const linkButton: React.CSSProperties = {
  fontSize: 12, padding: 0, border: 'none', background: 'none', cursor: 'pointer', color: 'var(--accent)',
};

