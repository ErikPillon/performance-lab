import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type ThresholdRow } from '../lib/api';
import { Badge, ErrorNote, Loading, Panel } from '../components/ui';
import * as f from '../lib/format';

/**
 * Threshold management.
 *
 * Every heart-rate-derived load number scales with LTHR, and resting HR cannot
 * be derived from activity files at all, so both start as estimates that need
 * correcting. Editing them is deliberately an append: a new effective-dated row
 * rather than a change in place, so a ride from 2021 keeps being scored against
 * 2021 fitness.
 */

interface Field {
  key: keyof FormState;
  label: string;
  unit: string;
  hint?: string;
  /** Shown as m:ss and stored as seconds. */
  asPace?: boolean;
}

const FIELDS: Field[] = [
  { key: 'maxHr', label: 'Max heart rate', unit: 'bpm', hint: 'Highest 5s average ever recorded' },
  { key: 'lthr', label: 'Lactate threshold HR', unit: 'bpm', hint: 'Usually 80–92% of max' },
  { key: 'restHr', label: 'Resting heart rate', unit: 'bpm', hint: 'Measure on waking — not derivable from activity files' },
  { key: 'ftpWatts', label: 'FTP', unit: 'W', hint: 'Functional threshold power' },
  { key: 'thresholdPaceSecPerKm', label: 'Threshold pace', unit: '/km', hint: 'Roughly 1-hour race pace', asPace: true },
  { key: 'cssSecPer100m', label: 'Critical swim speed', unit: '/100m', hint: 'Sustainable swim pace', asPace: true },
  { key: 'weightKg', label: 'Weight', unit: 'kg' },
];

type FormState = {
  maxHr: string;
  lthr: string;
  restHr: string;
  ftpWatts: string;
  thresholdPaceSecPerKm: string;
  cssSecPer100m: string;
  weightKg: string;
  effectiveFrom: string;
  note: string;
};

/** "4:27" or "267" -> 267 seconds. Accepts either, since both read naturally. */
function parsePace(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes(':')) {
    const [m, s] = trimmed.split(':');
    const minutes = Number(m);
    const seconds = Number(s);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    return minutes * 60 + seconds;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function toForm(row: ThresholdRow | undefined): FormState {
  return {
    maxHr: row?.maxHr?.toString() ?? '',
    lthr: row?.lthr?.toString() ?? '',
    restHr: row?.restHr?.toString() ?? '',
    ftpWatts: row?.ftpWatts?.toString() ?? '',
    thresholdPaceSecPerKm: row?.thresholdPaceSecPerKm ? f.pace(row.thresholdPaceSecPerKm) : '',
    cssSecPer100m: row?.cssSecPer100m ? f.pace(row.cssSecPer100m) : '',
    weightKg: row?.weightKg?.toString() ?? '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
    note: '',
  };
}

export function Thresholds({ athleteId }: { athleteId: string }) {
  const queryClient = useQueryClient();
  const history = useQuery({
    queryKey: ['thresholds', athleteId],
    queryFn: () => api.thresholds(athleteId),
  });

  const [form, setForm] = useState<FormState | null>(null);
  const [advisories, setAdvisories] = useState<string[]>([]);

  const latest = history.data?.thresholds[0];
  // Seed the form from the newest row once, then leave the user's edits alone.
  useEffect(() => {
    if (history.data && form === null) setForm(toForm(latest));
  }, [history.data, latest, form]);

  const save = useMutation({
    mutationFn: (state: FormState) =>
      api.saveThresholds(athleteId, {
        effectiveFrom: state.effectiveFrom,
        maxHr: state.maxHr ? Number(state.maxHr) : null,
        lthr: state.lthr ? Number(state.lthr) : null,
        restHr: state.restHr ? Number(state.restHr) : null,
        ftpWatts: state.ftpWatts ? Number(state.ftpWatts) : null,
        weightKg: state.weightKg ? Number(state.weightKg) : null,
        thresholdPaceSecPerKm: parsePace(state.thresholdPaceSecPerKm),
        cssSecPer100m: parsePace(state.cssSecPer100m),
        note: state.note || 'entered manually',
      }),
    onSuccess: (data) => {
      setAdvisories(data.advisories);
      queryClient.invalidateQueries({ queryKey: ['thresholds', athleteId] });
      queryClient.invalidateQueries({ queryKey: ['recompute', athleteId] });
    },
  });

  const remove = useMutation({
    mutationFn: (effectiveFrom: string) => api.deleteThreshold(athleteId, effectiveFrom),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['thresholds', athleteId] }),
  });

  if (history.isError) return <ErrorNote error={history.error} />;
  if (!history.data || !form) return <Loading what="thresholds" />;

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <RecomputePanel athleteId={athleteId} />
      <EffectivePanel athleteId={athleteId} />

      <Panel
        title="Set thresholds"
        subtitle="Saving adds a new dated entry; older activities keep being scored against the values in effect when they happened."
      >
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          {FIELDS.map((field) => (
            <label key={field.key} style={{ display: 'block' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>
                {field.label}
                <span style={{ color: 'var(--faint)', fontWeight: 400 }}> ({field.unit})</span>
              </div>
              <input
                value={form[field.key]}
                onChange={set(field.key)}
                placeholder={field.asPace ? 'm:ss' : ''}
                inputMode={field.asPace ? 'text' : 'decimal'}
                style={inputStyle}
              />
              {field.hint && (
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>{field.hint}</div>
              )}
            </label>
          ))}

          <label>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>Effective from</div>
            <input type="date" value={form.effectiveFrom} onChange={set('effectiveFrom')} style={inputStyle} />
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 3 }}>
              When these became true, not today's date
            </div>
          </label>

          <label>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3 }}>Note</div>
            <input value={form.note} onChange={set('note')} placeholder="e.g. 20min field test" style={inputStyle} />
          </label>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
          <button onClick={() => save.mutate(form)} disabled={save.isPending} style={primaryButton}>
            {save.isPending ? 'Saving…' : 'Save thresholds'}
          </button>
          {save.isSuccess && !save.isPending && (
            <span style={{ fontSize: 13, color: 'var(--good)' }}>
              Saved — recompute to apply it to stored activities.
            </span>
          )}
        </div>

        {save.isError && (
          <div style={{ marginTop: 12, fontSize: 13, color: 'var(--bad)' }}>
            {save.error instanceof Error ? save.error.message : 'Could not save'}
          </div>
        )}
        {advisories.map((note) => (
          <div key={note} style={{ marginTop: 12, fontSize: 13, color: 'var(--warn)', display: 'flex', gap: 8 }}>
            <Badge tone="warn">Check</Badge>
            <span>{note}</span>
          </div>
        ))}
      </Panel>

      <Panel title="History" pad={false} subtitle="Each row applies from its date until the next one">
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Effective from</th>
                <th style={{ textAlign: 'right' }}>Max HR</th>
                <th style={{ textAlign: 'right' }}>LTHR</th>
                <th style={{ textAlign: 'right' }}>Rest HR</th>
                <th style={{ textAlign: 'right' }}>FTP</th>
                <th style={{ textAlign: 'right' }}>Thr. pace</th>
                <th style={{ textAlign: 'right' }}>CSS</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.data.thresholds.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    {row.effectiveFrom}
                    {i === 0 && <span style={{ marginLeft: 8 }}><Badge tone="good">current</Badge></span>}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>{row.maxHr ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{row.lthr ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{row.restHr ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{row.ftpWatts ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {row.thresholdPaceSecPerKm ? f.pace(row.thresholdPaceSecPerKm) : '—'}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {row.cssSecPer100m ? f.pace(row.cssSecPer100m) : '—'}
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'normal', maxWidth: 260 }}>
                    {row.note}
                  </td>
                  <td>
                    <button
                      onClick={() => {
                        if (confirm(`Delete the entry effective ${row.effectiveFrom}?`)) {
                          remove.mutate(row.effectiveFrom);
                        }
                      }}
                      style={{ ...ghostButton, color: 'var(--bad)' }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/**
 * What is actually in effect right now, and where each value came from.
 *
 * Worth showing explicitly because resolution is per field, not per row: max HR
 * can come from one dated entry while critical swim speed still comes from an
 * older one. Without this the numbers look like they came from a single record
 * and the effective-dating is invisible.
 */
function EffectivePanel({ athleteId }: { athleteId: string }) {
  const summary = useQuery({ queryKey: ['summary', athleteId], queryFn: () => api.summary(athleteId) });
  const t = summary.data?.thresholds;
  if (!t) return null;

  const rows: { label: string; value: string; source?: string }[] = [
    { label: 'Max heart rate', value: t.maxHr ? `${t.maxHr} bpm` : '—', source: t.sources?.max_hr },
    { label: 'Lactate threshold HR', value: t.lthr ? `${t.lthr} bpm` : '—', source: t.sources?.lthr },
    { label: 'Resting heart rate', value: t.restHr ? `${t.restHr} bpm` : '—', source: t.sources?.rest_hr },
    { label: 'FTP', value: t.ftpWatts ? `${t.ftpWatts} W` : '—', source: t.sources?.ftp_watts },
    {
      label: 'Threshold pace',
      value: t.thresholdPaceSecPerKm ? `${f.pace(t.thresholdPaceSecPerKm)} /km` : '—',
      source: t.sources?.threshold_pace_sec_per_km,
    },
    {
      label: 'Critical swim speed',
      value: t.cssSecPer100m ? `${f.pace(t.cssSecPer100m)} /100m` : '—',
      source: t.sources?.css_sec_per_100m,
    },
  ];

  const lthrFraction = t.lthr && t.maxHr ? t.lthr / t.maxHr : null;
  const lthrSuspect = lthrFraction !== null && (lthrFraction > 0.92 || lthrFraction < 0.8);

  return (
    <Panel
      title="Currently in effect"
      subtitle="Each value carries forward from the most recent entry that set it — measuring a new FTP does not erase your CSS."
    >
      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        {rows.map((row) => (
          <div key={row.label}>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--faint)' }}>
              {row.label}
            </div>
            <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>{row.value}</div>
            <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 1 }}>
              {row.source ? `set ${row.source}` : 'not set'}
            </div>
          </div>
        ))}
      </div>

      {lthrSuspect && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14, fontSize: 13, alignItems: 'flex-start' }}>
          <Badge tone="warn">Check</Badge>
          <span style={{ color: 'var(--muted)' }}>
            LTHR is {Math.round(lthrFraction! * 100)}% of max HR, outside the usual 80–92% band. Every
            heart-rate-derived load number scales with it, so a field test is the single highest-value
            correction you can make here.
          </span>
        </div>
      )}
    </Panel>
  );
}

/** Recompute control, plus whether stored results are behind the current model. */
function RecomputePanel({ athleteId }: { athleteId: string }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['recompute', athleteId],
    queryFn: () => api.recomputeStatus(athleteId),
    // Poll only while something is running, so an idle page is quiet.
    refetchInterval: (query) => {
      const state = query.state.data?.job?.state;
      return state === 'active' || state === 'waiting' ? 1_000 : false;
    },
  });

  const run = useMutation({
    mutationFn: (estimateThresholds: boolean) => api.recompute(athleteId, { estimateThresholds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recompute', athleteId] });
    },
  });

  const job = status.data?.job;
  const running = job?.state === 'active' || job?.state === 'waiting';
  const progress = typeof job?.progress === 'object' ? job.progress : null;
  const stale = status.data?.staleRows ?? 0;

  // Everything downstream of the raw files is rebuilt from stored streams, so a
  // recompute is always safe to re-run and never re-reads a FIT file.
  useEffect(() => {
    if (job?.state === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['summary', athleteId] });
      queryClient.invalidateQueries({ queryKey: ['pmc', athleteId] });
      queryClient.invalidateQueries({ queryKey: ['activities', athleteId] });
      queryClient.invalidateQueries({ queryKey: ['zones', athleteId] });
    }
  }, [job?.state, job?.finishedOn, athleteId, queryClient]);

  return (
    <Panel
      title="Recompute"
      subtitle="Rebuilds load and the fitness model from stored streams. No files are re-read and nothing is fetched from a vendor."
    >
      {stale > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
          <Badge tone="warn">Stale</Badge>
          <span style={{ color: 'var(--muted)' }}>
            {stale.toLocaleString()} activities were scored by an older version of the load model
            {status.data?.currentVersion && ` (current is ${status.data.currentVersion})`}.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => run.mutate(false)} disabled={running || run.isPending} style={primaryButton}>
          {running ? 'Running…' : 'Recompute'}
        </button>
        <button onClick={() => run.mutate(true)} disabled={running || run.isPending} style={ghostButton}>
          Re-estimate thresholds and recompute
        </button>

        {running && progress && (
          <span className="num" style={{ fontSize: 13, color: 'var(--muted)' }}>
            {progress.phase === 'load' && progress.total
              ? `scoring ${progress.done}/${progress.total}`
              : progress.phase === 'thresholds'
                ? 'estimating thresholds'
                : progress.phase === 'pmc'
                  ? 'building fitness model'
                  : progress.phase}
          </span>
        )}
        {job?.state === 'completed' && !running && (
          <span style={{ fontSize: 13, color: 'var(--good)' }}>Up to date</span>
        )}
        {job?.state === 'failed' && (
          <span style={{ fontSize: 13, color: 'var(--bad)' }}>Failed: {job.failedReason}</span>
        )}
      </div>

      <div style={{ fontSize: 12, color: 'var(--faint)', marginTop: 10 }}>
        Re-estimating thresholds overwrites the auto-generated entry with fresh values derived from
        your training history. It does not touch entries you have added yourself.
      </div>
    </Panel>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  fontSize: 14,
  fontVariantNumeric: 'tabular-nums',
  borderRadius: 7,
  border: '1px solid var(--border-strong)',
  background: 'var(--panel-2)',
  color: 'var(--text)',
};

const primaryButton: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: '7px 16px',
  borderRadius: 7,
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: '#fff',
  cursor: 'pointer',
};

const ghostButton: React.CSSProperties = {
  fontSize: 13,
  padding: '7px 14px',
  borderRadius: 7,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text)',
  cursor: 'pointer',
};
