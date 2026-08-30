import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ActivityRow } from '../lib/api';
import { buildWeeks, type WeekRow } from '../lib/weeks';
import { Badge, ErrorNote, Loading, Panel } from '../components/ui';
import * as f from '../lib/format';

/**
 * Training calendar.
 *
 * Triathletes plan and review in weeks, and a reverse-chronological list cannot
 * show that this is a recovery week, or that Tuesday is always the session that
 * gets missed. The week column carries the risk signals the model already
 * computes, so a hard week and the ramp that produced it are visible together.
 */

const RANGES = [
  { label: '8 weeks', weeks: 8 },
  { label: '3 months', weeks: 13 },
  { label: '6 months', weeks: 26 },
  { label: '1 year', weeks: 52 },
];

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Calendar({ athleteId }: { athleteId: string }) {
  const [range, setRange] = useState(RANGES[1]!);

  const summary = useQuery({ queryKey: ['summary', athleteId], queryFn: () => api.summary(athleteId) });

  // Anchored to the last activity rather than today: an athlete between blocks
  // should land on their training, not on empty weeks.
  const anchor = summary.data?.totals.last ? new Date(summary.data.totals.last) : new Date();
  const to = anchor;
  const from = new Date(anchor.getTime() - range.weeks * 7 * 86_400_000);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);

  const activities = useQuery({
    queryKey: ['calendarActivities', athleteId, fromIso, toIso],
    queryFn: () => api.activities(athleteId, { from: fromIso, to: toIso, limit: 500 }),
    enabled: !!summary.data,
  });
  const pmc = useQuery({
    queryKey: ['pmc', athleteId, 'calendar', fromIso, toIso],
    queryFn: () => api.pmc(athleteId, fromIso, toIso),
    enabled: !!summary.data,
  });

  const weeks = useMemo(() => {
    if (!activities.data || !pmc.data) return [];
    return buildWeeks(activities.data.activities, pmc.data.series, from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activities.data, pmc.data, fromIso, toIso]);

  if (activities.isError) return <ErrorNote error={activities.error} />;

  const peakLoad = Math.max(1, ...weeks.map((w) => w.load));

  return (
    <Panel
      title="Calendar"
      subtitle="Weeks start Monday. Hours and load are per week; risk flags come from the fitness model."
      pad={false}
      right={
        <div style={{ display: 'flex', gap: 4 }}>
          {RANGES.map((r) => (
            <button
              key={r.weeks}
              onClick={() => setRange(r)}
              style={{
                fontSize: 12,
                padding: '3px 9px',
                borderRadius: 6,
                cursor: 'pointer',
                border: `1px solid ${r.weeks === range.weeks ? 'var(--accent)' : 'var(--border)'}`,
                background:
                  r.weeks === range.weeks ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                color: r.weeks === range.weeks ? 'var(--accent)' : 'var(--muted)',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      {!activities.data || !pmc.data ? (
        <Loading what="calendar" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 900 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, 1fr) 160px',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'var(--panel)',
                zIndex: 1,
              }}
            >
              {DAY_NAMES.map((d) => (
                <div key={d} style={headerCell}>
                  {d}
                </div>
              ))}
              <div style={{ ...headerCell, textAlign: 'right' }}>Week</div>
            </div>

            {weeks.map((week) => (
              <WeekRowView key={week.start} week={week} peakLoad={peakLoad} />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function WeekRowView({ week, peakLoad }: { week: WeekRow; peakLoad: number }) {
  const empty = week.sessions === 0;
  const monthLabel = new Date(week.start).toLocaleDateString(undefined, { month: 'short' });
  const startsMonth = new Date(week.start).getUTCDate() <= 7;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(7, 1fr) 160px',
        borderBottom: '1px solid var(--border)',
        opacity: empty ? 0.55 : 1,
        borderTop: startsMonth ? '2px solid var(--border-strong)' : undefined,
      }}
    >
      {week.days.map((day, i) => {
        const dayNumber = new Date(day.date).getUTCDate();
        return (
          <div
            key={day.date}
            style={{
              padding: '7px 8px 9px',
              borderRight: '1px solid var(--border)',
              minHeight: 74,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--faint)', display: 'flex', gap: 5 }}>
              <span className="num">{dayNumber}</span>
              {i === 0 && startsMonth && <span style={{ fontWeight: 600 }}>{monthLabel}</span>}
            </div>
            {day.activities.map((a) => (
              <SessionChip key={a.id} activity={a} />
            ))}
          </div>
        );
      })}

      <div style={{ padding: '8px 12px', textAlign: 'right', display: 'grid', gap: 3, alignContent: 'start' }}>
        {empty ? (
          <div style={{ fontSize: 12, color: 'var(--faint)' }}>no training</div>
        ) : (
          <>
            <div className="num" style={{ fontSize: 15, fontWeight: 600 }}>
              {f.duration(week.durationS)}
            </div>
            <div className="num" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {Math.round(week.load)} load
              {week.changeVsPrevious !== null && Math.abs(week.changeVsPrevious) > 0.15 && (
                <span
                  style={{
                    marginLeft: 5,
                    color: week.changeVsPrevious > 0 ? 'var(--warn)' : 'var(--muted)',
                  }}
                >
                  {week.changeVsPrevious > 0 ? '▲' : '▼'}
                  {Math.abs(Math.round(week.changeVsPrevious * 100))}%
                </span>
              )}
            </div>
            <div style={{ height: 4, background: 'var(--panel-2)', borderRadius: 2, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.min(100, (week.load / peakLoad) * 100)}%`,
                  height: '100%',
                  background: 'var(--accent)',
                }}
              />
            </div>
            <div style={{ fontSize: 11, color: 'var(--faint)', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {week.ctl !== null && <span className="num">CTL {week.ctl.toFixed(0)}</span>}
              <span>{week.restDays}d rest</span>
            </div>
            <WeekFlags week={week} />
          </>
        )}
      </div>
    </div>
  );
}

/** Risk signals from the model, surfaced next to the week that caused them. */
function WeekFlags({ week }: { week: WeekRow }) {
  const flags: { tone: 'warn' | 'bad'; label: string; title: string }[] = [];

  if (week.acwr !== null && week.acwr > 1.5) {
    flags.push({
      tone: week.acwr > 2 ? 'bad' : 'warn',
      label: `ACWR ${week.acwr.toFixed(1)}`,
      title:
        'Acute:chronic workload ratio above 1.5 — this week is well beyond what the last month prepared for.',
    });
  }
  if (week.monotony !== null && week.monotony > 2) {
    flags.push({
      tone: 'warn',
      label: `mono ${week.monotony.toFixed(1)}`,
      title: 'Every day looks alike. Undifferentiated training adapts poorly regardless of volume.',
    });
  }
  if (flags.length === 0) return null;

  return (
    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {flags.map((flag) => (
        <span key={flag.label} title={flag.title}>
          <Badge tone={flag.tone}>{flag.label}</Badge>
        </span>
      ))}
    </div>
  );
}

function SessionChip({ activity }: { activity: ActivityRow }) {
  const flagged = activity.qualityFlags.some((flag) => flag.startsWith('implausible'));
  const label =
    activity.sport === 'swimming'
      ? f.km(activity.distanceM, 1) === '—'
        ? f.duration(activity.durationS)
        : `${Math.round(activity.distanceM ?? 0)}m`
      : activity.distanceM
        ? `${f.km(activity.distanceM)}k`
        : f.duration(activity.durationS);

  return (
    <Link
      to={`/activities/${activity.id}`}
      title={`${activity.sport} · ${f.duration(activity.durationS)} · ${f.num(activity.load)} load`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        textDecoration: 'none',
        color: 'var(--text)',
        background: 'var(--panel-2)',
        border: `1px solid ${flagged ? 'color-mix(in srgb, var(--bad) 45%, transparent)' : 'var(--border)'}`,
        borderLeft: `3px solid ${f.sportColor(activity.sport)}`,
        borderRadius: 4,
        padding: '2px 5px',
        lineHeight: 1.4,
      }}
    >
      <span className="num" style={{ fontWeight: 600 }}>
        {label}
      </span>
      <span className="num" style={{ marginLeft: 'auto', color: 'var(--faint)' }}>
        {activity.load ? Math.round(activity.load) : '—'}
      </span>
    </Link>
  );
}

const headerCell: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  color: 'var(--faint)',
  borderRight: '1px solid var(--border)',
};
