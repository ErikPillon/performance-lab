import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type uPlot from 'uplot';
import { api, type WellnessEntry } from '../lib/api';
import { Chart, themeColor, useThemeVersion } from '../components/Chart';
import { Empty } from '../components/PmcChart';
import { Badge, ErrorNote, Loading, Panel, Stat } from '../components/ui';
import { rollingMedian, withGapBreaks, type TrendPoint } from '../lib/trends';

/**
 * Morning wellness.
 *
 * Two jobs. The obvious one is readiness — resting heart rate and HRV against
 * training load. The quieter one matters more: resting heart rate cannot be
 * recovered from activity files, so the whole system has been running on a
 * hardcoded 50 feeding every heart-rate-reserve calculation. This is where a
 * real number comes from.
 */

const FEEL_LABEL = ['', 'wrecked', 'flat', 'ok', 'good', 'fresh'];

type Field = {
  key: 'restingHr' | 'hrvRmssdMs' | 'sleepHours' | 'weightKg';
  label: string;
  unit: string;
  step: string;
  placeholder: string;
};

const FIELDS: Field[] = [
  { key: 'restingHr', label: 'Resting HR', unit: 'bpm', step: '1', placeholder: '48' },
  { key: 'hrvRmssdMs', label: 'HRV (RMSSD)', unit: 'ms', step: '0.1', placeholder: '62' },
  { key: 'sleepHours', label: 'Sleep', unit: 'h', step: '0.25', placeholder: '7.5' },
  { key: 'weightKg', label: 'Weight', unit: 'kg', step: '0.1', placeholder: '71.0' },
];

export function Wellness({ athleteId }: { athleteId: string }) {
  const themeVersion = useThemeVersion();
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [values, setValues] = useState<Record<string, string>>({});
  const [feel, setFeel] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [advice, setAdvice] = useState<string[]>([]);

  const wellness = useQuery({
    queryKey: ['wellness', athleteId],
    queryFn: () => api.wellness(athleteId, { limit: 400 }),
  });
  const restingHr = useQuery({
    queryKey: ['restingHrSuggestion', athleteId],
    queryFn: () => api.restingHrSuggestion(athleteId),
  });

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { date, feel, note: note || null };
      for (const f of FIELDS) {
        const raw = values[f.key];
        // Empty means "not measured", which is a null, not a zero.
        body[f.key] = raw == null || raw === '' ? null : Number(raw);
      }
      return api.saveWellness(athleteId, body);
    },
    onSuccess: (result) => {
      setAdvice(result.advisories);
      setValues({});
      setFeel(null);
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['wellness', athleteId] });
      queryClient.invalidateQueries({ queryKey: ['restingHrSuggestion', athleteId] });
    },
  });

  const remove = useMutation({
    mutationFn: (d: string) => api.deleteWellness(athleteId, d),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wellness', athleteId] });
      queryClient.invalidateQueries({ queryKey: ['restingHrSuggestion', athleteId] });
    },
  });

  const entries = wellness.data?.entries ?? [];
  const latest = entries[entries.length - 1];

  if (wellness.isError) return <ErrorNote error={wellness.error} />;
  if (wellness.isLoading) return <Loading what="wellness" />;

  const anything = entries.length > 0;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/*
        The threshold prompt sits above everything else on purpose: it is the
        one thing on this page that changes numbers elsewhere in the system.
      */}
      {restingHr.data && <RestingHrPrompt data={restingHr.data} />}

      <Panel title="This morning" subtitle="Every field is optional — a day with only a weight still counts">
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Labelled label="Date">
            <input
              type="date"
              value={date}
              max={today}
              onChange={(e) => setDate(e.target.value)}
              style={inputStyle}
            />
          </Labelled>

          {FIELDS.map((f) => (
            <Labelled key={f.key} label={`${f.label} (${f.unit})`}>
              <input
                type="number"
                inputMode="decimal"
                step={f.step}
                placeholder={f.placeholder}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                style={{ ...inputStyle, width: 96 }}
              />
            </Labelled>
          ))}

          <Labelled label="How you feel">
            <div style={{ display: 'flex', gap: 4 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setFeel(feel === n ? null : n)}
                  title={FEEL_LABEL[n]}
                  style={{
                    width: 34,
                    height: 32,
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                    border: `1px solid ${feel === n ? 'var(--accent)' : 'var(--border)'}`,
                    background:
                      feel === n ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                    color: feel === n ? 'var(--accent)' : 'var(--muted)',
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </Labelled>
        </div>

        <div style={{ display: 'flex', gap: 14, marginTop: 14, alignItems: 'flex-end' }}>
          <Labelled label="Note">
            <input
              type="text"
              value={note}
              maxLength={500}
              placeholder="travel, illness, a bad night — anything that explains the numbers"
              onChange={(e) => setNote(e.target.value)}
              style={{ ...inputStyle, width: '100%' }}
            />
          </Labelled>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            style={{
              padding: '7px 16px',
              borderRadius: 7,
              cursor: save.isPending ? 'default' : 'pointer',
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: 'white',
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>

        {save.isError && (
          <div style={{ marginTop: 10 }}>
            <ErrorNote error={save.error} />
          </div>
        )}
        {advice.length > 0 && (
          <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
            {advice.map((a) => (
              <div key={a} style={{ fontSize: 13, color: 'var(--warn)' }}>
                {a}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {!anything ? (
        <Panel>
          <Empty>
            Nothing recorded yet. A single morning number a day is enough — resting heart rate is
            the one that changes how the rest of the system calculates.
          </Empty>
        </Panel>
      ) : (
        <>
          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
            <Stat label="Resting HR" value={latest?.restingHr?.toString() ?? '—'} unit="bpm"
              hint={latest ? `on ${latest.date}` : undefined} />
            <Stat label="HRV" value={latest?.hrvRmssdMs?.toFixed(0) ?? '—'} unit="ms" />
            <Stat label="Weight" value={latest?.weightKg?.toFixed(1) ?? '—'} unit="kg" />
            <Stat label="Days recorded" value={String(wellness.data?.coverage?.days ?? 0)}
              hint={`${wellness.data?.coverage?.withRestingHr ?? 0} with resting HR`} />
          </div>

          <Series title="Resting heart rate" unit="bpm" entries={entries} pick={(e) => e.restingHr}
            themeVersion={themeVersion} digits={0}
            subtitle="Lower is generally better, but the trend matters far more than any morning. A jump of five or more over a few days is worth taking seriously." />

          <Series title="Heart-rate variability" unit="ms" entries={entries} pick={(e) => e.hrvRmssdMs}
            themeVersion={themeVersion} digits={0}
            subtitle="RMSSD, stored raw rather than as a vendor readiness score — those are differently scaled between devices and not comparable across a device change." />

          <Series title="Weight" unit="kg" entries={entries} pick={(e) => e.weightKg}
            themeVersion={themeVersion} digits={1} />

          <Panel title="Recent entries" pad={false}>
            <div>
              {[...entries].reverse().slice(0, 30).map((e) => (
                <div key={e.date} style={rowStyle}>
                  <div className="num" style={{ width: 96 }}>{e.date}</div>
                  <Cell value={e.restingHr} unit="bpm" />
                  <Cell value={e.hrvRmssdMs} unit="ms" digits={0} />
                  <Cell value={e.sleepHours} unit="h" digits={1} />
                  <Cell value={e.weightKg} unit="kg" digits={1} />
                  <div style={{ width: 70, fontSize: 12, color: 'var(--muted)' }}>
                    {e.feel ? FEEL_LABEL[e.feel] : ''}
                  </div>
                  <div style={{ flex: 1, fontSize: 12, color: 'var(--muted)', minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {e.note ?? ''}
                  </div>
                  <button
                    onClick={() => remove.mutate(e.date)}
                    style={{ fontSize: 11, padding: '2px 7px', borderRadius: 5, cursor: 'pointer',
                      border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)' }}
                  >
                    delete
                  </button>
                </div>
              ))}
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

/**
 * The bridge between a measurement and the number the system actually uses.
 *
 * Deliberately a prompt rather than an automatic write. Resting heart rate is
 * an effective-dated threshold, and silently rewriting it would rescale every
 * TRIMP value in the athlete's history without anyone asking for it.
 */
function RestingHrPrompt({ data }: { data: { samples: number; suggestion: number | null; days: number } }) {
  if (data.suggestion == null) {
    return (
      <Panel>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          Resting heart rate cannot be read from activity files, so the system is using a{' '}
          <strong>default of 50</strong> in every heart-rate-reserve calculation. Record{' '}
          {Math.max(0, 14 - data.samples)} more morning{14 - data.samples === 1 ? '' : 's'} and a
          measured value can replace it.
        </div>
      </Panel>
    );
  }
  return (
    <Panel>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone="good">measured</Badge>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, flex: 1, minWidth: 260 }}>
          Your median resting heart rate over {data.samples} mornings is{' '}
          <strong className="num">{data.suggestion} bpm</strong>. Set it on{' '}
          <Link to="/thresholds" style={{ color: 'var(--accent)' }}>thresholds</Link> to replace the
          default of 50 — it is effective-dated, so it will not silently rewrite past numbers.
        </div>
      </div>
    </Panel>
  );
}

function Series({
  title, subtitle, unit, entries, pick, themeVersion, digits = 0,
}: {
  title: string;
  subtitle?: string;
  unit: string;
  entries: WellnessEntry[];
  pick: (e: WellnessEntry) => number | null;
  themeVersion: number;
  digits?: number;
}) {
  const points = useMemo<TrendPoint[]>(
    () => entries.map((e) => ({ x: Date.parse(`${e.date}T00:00:00Z`), y: pick(e) })),
    [entries, pick],
  );

  const data = useMemo<uPlot.AlignedData>(() => {
    // A fortnight rather than the six weeks the fitness trends use: resting
    // heart rate responds to a hard block in days, and a long window would
    // smooth away exactly the movement worth seeing.
    //
    // Gaps are broken for the same reason as on the fitness trends: a median is
    // well-defined either side of a fortnight away from the strap, so nothing
    // is null and the line is drawn straight across the missing weeks.
    const series = withGapBreaks(points, { maxGapDays: 14 });
    const smoothed = rollingMedian(series, { halfWindowDays: 7, minPoints: 3 });
    return [series.map((p) => p.x / 1000), series.map((p) => p.y), smoothed];
  }, [points]);

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
          stroke: axisText, grid, ticks: grid, size: 50,
          values: (_u, splits) => splits.map((v) => (v == null ? '' : v.toFixed(digits))),
        },
      ],
      series: [
        { label: 'date' },
        {
          label: 'Reading',
          stroke: `${accent}66`,
          width: 0,
          points: { show: true, size: 4, stroke: `${accent}99`, fill: `${accent}44` },
        },
        { label: 'Rolling median', stroke: accent, width: 2.5, points: { show: false }, spanGaps: false },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeVersion, digits]);

  const measured = points.filter((p) => p.y != null).length;
  if (measured === 0) return null;

  return (
    <Panel title={title} subtitle={subtitle}>
      <Chart data={data} options={options} height={200} themeVersion={themeVersion} />
      <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
        {measured} reading{measured === 1 ? '' : 's'} · {unit} · median over a centred 14-day window
      </div>
    </Panel>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '6px 9px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--panel)',
  color: 'var(--text)',
  fontSize: 13,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 16px',
  borderTop: '1px solid var(--border)',
  fontSize: 13,
};

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 4, flex: label === 'Note' ? 1 : undefined }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--faint)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function Cell({ value, unit, digits = 0 }: { value: number | null; unit: string; digits?: number }) {
  return (
    <div className="num" style={{ width: 72, color: value == null ? 'var(--faint)' : undefined }}>
      {value == null ? '—' : `${value.toFixed(digits)} `}
      {value != null && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{unit}</span>}
    </div>
  );
}
