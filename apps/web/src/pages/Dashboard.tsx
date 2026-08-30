import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { PmcChart, PmcLegend, Empty } from '../components/PmcChart';
import { Badge, Bar, ErrorNote, Loading, Panel, SportDot, Stat } from '../components/ui';
import * as f from '../lib/format';
import { ZONE_COLOR, ZONE_LABEL } from '../lib/zones';

const RANGES = [
  { label: '3m', days: 90 },
  { label: '6m', days: 182 },
  { label: '1y', days: 365 },
  { label: 'All', days: 0 },
];


export function Dashboard({ athleteId }: { athleteId: string }) {
  const [range, setRange] = useState(RANGES[2]!);

  const summary = useQuery({ queryKey: ['summary', athleteId], queryFn: () => api.summary(athleteId) });

  // Ranges are anchored to the last activity, not to today. Anchoring to today
  // means an athlete who has not trained for months opens the dashboard to a
  // chart that is almost entirely flat decay, with the training that produced
  // the curve pushed off the left edge.
  const anchor = summary.data?.totals.last ? new Date(summary.data.totals.last) : new Date();
  const to = anchor.toISOString().slice(0, 10);
  const from = range.days
    ? new Date(anchor.getTime() - range.days * 86_400_000).toISOString().slice(0, 10)
    : undefined;
  const pmc = useQuery({
    queryKey: ['pmc', athleteId, range.days, to],
    queryFn: () => api.pmc(athleteId, from, range.days ? to : undefined),
    enabled: !!summary.data,
  });
  const zones = useQuery({
    queryKey: ['zones', athleteId, range.days, to],
    queryFn: () => api.zones(athleteId, from, range.days ? to : undefined),
    enabled: !!summary.data,
  });
  const recent = useQuery({
    queryKey: ['recent', athleteId],
    queryFn: () => api.activities(athleteId, { limit: 8 }),
  });

  if (summary.isError) return <ErrorNote error={summary.error} />;
  if (!summary.data) return <Loading what="summary" />;

  const { current, totals, thresholds, bySport } = summary.data;
  const form = current ? f.formLabel(current.tsb) : null;

  // The model runs to today, but fitness decays to nothing after a long break.
  // Saying so is more useful than showing a confident zero.
  const lastActivity = totals.last ? new Date(totals.last) : null;
  const daysSince = lastActivity
    ? Math.floor((Date.now() - lastActivity.getTime()) / 86_400_000)
    : null;
  const stale = daysSince !== null && daysSince > 30;

  const zoneTotal = (zones.data?.zones ?? []).reduce((sum, z) => sum + z.seconds, 0);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {stale && (
        <div
          className="panel"
          style={{ padding: '10px 14px', fontSize: 13, color: 'var(--muted)', display: 'flex', gap: 8 }}
        >
          <Badge tone="warn">Stale</Badge>
          Last activity was {daysSince} days ago, so fitness has decayed to near zero. The curve below
          shows the history.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Stat
          label="Fitness"
          value={f.num(current?.ctl, 1)}
          hint="CTL · 42-day load"
          color="var(--ctl)"
        />
        <Stat
          label="Fatigue"
          value={f.num(current?.atl, 1)}
          hint="ATL · 7-day load"
          color="var(--atl)"
        />
        <Stat
          label="Form"
          value={f.num(current?.tsb, 1)}
          hint={form?.label}
          color={form?.color}
        />
        <Stat label="Total time" value={f.hours(totals.durationS, 0)} unit="h" hint={`${totals.activities} activities`} />
        <Stat label="Distance" value={f.km(totals.distanceM, 0)} unit="km" hint={
          totals.first ? `since ${f.date(totals.first, { year: 'numeric' })}` : undefined
        } />
      </div>

      <Panel
        title="Fitness, fatigue and form"
        subtitle={<PmcLegend />}
        right={
          <div style={{ display: 'flex', gap: 4 }}>
            {RANGES.map((r) => (
              <button
                key={r.label}
                onClick={() => setRange(r)}
                style={{
                  fontSize: 12,
                  padding: '3px 9px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  border: `1px solid ${r.label === range.label ? 'var(--accent)' : 'var(--border)'}`,
                  background: r.label === range.label ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                  color: r.label === range.label ? 'var(--accent)' : 'var(--muted)',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      >
        {pmc.isLoading ? (
          <Loading what="fitness model" />
        ) : (
          <PmcChart series={pmc.data?.series ?? []} height={300} />
        )}
      </Panel>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Panel title="Training by sport" subtitle="excluding activities flagged implausible">
          <div style={{ display: 'grid', gap: 12 }}>
            {bySport
              .filter((s) => s.durationS > 0)
              .sort((a, b) => b.durationS - a.durationS)
              .map((s) => {
                const max = Math.max(...bySport.map((x) => x.durationS));
                return (
                  <div key={s.sport}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                      <span style={{ textTransform: 'capitalize' }}>
                        <SportDot sport={s.sport} />
                        {s.sport}
                      </span>
                      <span className="num" style={{ color: 'var(--muted)' }}>
                        {f.hours(s.durationS)} h · {f.km(s.distanceM, 0)} km · {s.activities}×
                      </span>
                    </div>
                    <Bar fraction={s.durationS / max} color={f.sportColor(s.sport)} />
                  </div>
                );
              })}
          </div>
        </Panel>

        <Panel
          title="Time in heart-rate zones"
          subtitle={range.days ? `last ${range.label} of training` : 'all recorded activities'}
        >
          {zoneTotal === 0 ? (
            <Empty>No zone data — thresholds may not be set.</Empty>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {(zones.data?.zones ?? []).map((z) => (
                <div key={z.zone}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                    <span>{ZONE_LABEL[z.zone] ?? z.zone}</span>
                    <span className="num" style={{ color: 'var(--muted)' }}>
                      {f.hours(z.seconds)} h · {Math.round((z.seconds / zoneTotal) * 100)}%
                    </span>
                  </div>
                  <Bar fraction={z.seconds / zoneTotal} color={ZONE_COLOR[z.zone] ?? 'var(--other)'} />
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Recent activities"
        pad={false}
        right={
          <Link to="/activities" style={{ fontSize: 12, color: 'var(--accent)' }}>
            View all →
          </Link>
        }
      >
        <div style={{ overflowX: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Sport</th>
                <th style={{ textAlign: 'right' }}>Time</th>
                <th style={{ textAlign: 'right' }}>Distance</th>
                <th style={{ textAlign: 'right' }}>Avg HR</th>
                <th style={{ textAlign: 'right' }}>Load</th>
              </tr>
            </thead>
            <tbody>
              {(recent.data?.activities ?? []).map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/activities/${a.id}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                      {f.date(a.startTime, { year: 'numeric' })}
                    </Link>
                  </td>
                  <td style={{ textTransform: 'capitalize' }}>
                    <SportDot sport={a.sport} />
                    {a.sport}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>{f.duration(a.durationS)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{f.km(a.distanceM)}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{a.avgHr ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'right' }}>{f.num(a.load)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {thresholds && (
        <Panel title="Thresholds" subtitle={thresholds.note ?? undefined}>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13 }}>
            <Field label="Max HR" value={thresholds.maxHr} unit="bpm" />
            <Field label="LTHR" value={thresholds.lthr} unit="bpm" />
            <Field label="Resting HR" value={thresholds.restHr} unit="bpm" warn="default — please measure" />
            <Field label="FTP" value={thresholds.ftpWatts} unit="W" />
            <Field
              label="Threshold pace"
              value={thresholds.thresholdPaceSecPerKm ? f.pace(thresholds.thresholdPaceSecPerKm) : null}
              unit="/km"
            />
            <Field
              label="CSS"
              value={thresholds.cssSecPer100m ? f.pace(thresholds.cssSecPer100m) : null}
              unit="/100m"
            />
          </div>
        </Panel>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  unit,
  warn,
}: {
  label: string;
  value: number | string | null;
  unit?: string;
  warn?: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--faint)' }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 17, fontWeight: 600 }}>
        {value ?? '—'}
        {value !== null && unit && (
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted)' }}> {unit}</span>
        )}
      </div>
      {warn && value !== null && (
        <div style={{ fontSize: 11, color: 'var(--warn)', marginTop: 2 }}>{warn}</div>
      )}
    </div>
  );
}
