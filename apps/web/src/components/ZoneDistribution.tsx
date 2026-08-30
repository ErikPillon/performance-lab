import { useMemo } from 'react';
import type { ZoneTrendResponse } from '../lib/api';
import { Badge } from './ui';
import { ZONE_COLOR, ZONE_LABEL, ZONE_ORDER, classify, percentages, sumZones, toThreeZone } from '../lib/zones';

/**
 * Intensity distribution over time.
 *
 * Column height tracks total recorded time, and the stack within it is the
 * composition. Normalising every column to full height was the first attempt
 * and it lied: June 2024 holds 1.7 hours, nearly all of it hard, and rendered
 * full-height it screamed a training shape that one session cannot support —
 * directly beside a 30-hour month drawn exactly the same size. Height carries
 * how much this column is entitled to claim.
 *
 * Plain flex boxes rather than a chart: a stacked column per month is a dozen
 * divs, it inherits theme colours for free, and the labels stay selectable
 * text rather than canvas pixels.
 */

const SHAPE_NOTE: Record<string, string> = {
  pyramidal:
    'Most time easy, tapering through the middle to very little hard work. The default endurance shape, and a sound base-building one.',
  polarised:
    'Most time easy, more time hard than in the middle. The middle is deliberately hollow — this is a sharpening shape.',
  threshold:
    'A large share between the two thresholds. Sustainable for a while and effective, but it is the shape that accumulates fatigue fastest for the fitness it returns.',
  insufficient: 'Not enough recorded time in this range to describe a shape.',
};

/** "2026-08-01" -> "Aug 26". The full ISO date is in the column's tooltip. */
function shortMonth(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCFullYear()).slice(2)}`;
}

export function ZoneDistribution({ data }: { data: ZoneTrendResponse }) {
  const overall = useMemo(() => toThreeZone(sumZones(data.periods)), [data.periods]);
  const shape = classify(overall);
  const pct = percentages(overall);
  // The tallest month sets the scale, so heights are comparable across the
  // whole range rather than within each column.
  const peak = useMemo(
    () =>
      Math.max(
        1,
        ...data.periods.map((p) => Object.values(p.zones).reduce((a, b) => a + b, 0)),
      ),
    [data.periods],
  );

  if (data.periods.length === 0) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 13 }}>
        No zone data yet. Zones need heart rate and a threshold on file.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <Badge tone={shape === 'threshold' ? 'warn' : 'good'}>{shape}</Badge>
        <span className="num" style={{ fontSize: 13, color: 'var(--muted)' }}>
          {pct.easy.toFixed(0)}% easy · {pct.moderate.toFixed(0)}% moderate · {pct.hard.toFixed(0)}% hard
        </span>
        <span style={{ fontSize: 12, color: 'var(--faint)' }}>
          {(overall.total / 3600).toFixed(0)} h total
        </span>
      </div>

      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 16 }}>
        {SHAPE_NOTE[shape]}
      </div>

      <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 180 }}>
        {data.periods.map((period) => {
          const total = Object.values(period.zones).reduce((a, b) => a + b, 0);
          const hours = total / 3600;
          return (
            <div
              key={period.start}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                // Floor of 2%: a month with a single short session should still
                // be visible as a mark rather than vanishing into the axis.
                height: `${Math.max((total / peak) * 100, 2)}%`,
                minWidth: 8,
              }}
              title={`${period.start} — ${hours.toFixed(1)} h\n${ZONE_ORDER.map(
                (z) => `${ZONE_LABEL[z]}: ${(((period.zones[z] ?? 0) / (total || 1)) * 100).toFixed(0)}%`,
              ).join('\n')}`}
            >
              {/* Drawn top-down so the hardest zone caps the column. */}
              {[...ZONE_ORDER].reverse().map((zone) => {
                const share = total > 0 ? (period.zones[zone] ?? 0) / total : 0;
                if (share === 0) return null;
                return (
                  <div
                    key={zone}
                    style={{ height: `${share * 100}%`, background: ZONE_COLOR[zone], minHeight: 1 }}
                  />
                );
              })}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 3, marginTop: 6 }}>
        {data.periods.map((period, i) => (
          <div
            key={period.start}
            style={{
              flex: 1,
              minWidth: 8,
              fontSize: 10,
              color: 'var(--faint)',
              textAlign: 'center',
              whiteSpace: 'nowrap',
              // Deliberately allowed to spill: a column is ~25px wide and a
              // date is wider than that, so clipping turned every label into
              // "2024-0". Only every third cell carries text, and the two
              // empty neighbours are exactly the room it spills into.
              overflow: 'visible',
            }}
          >
            {i % 3 === 0 ? shortMonth(period.start) : ''}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--faint)' }}>
        Column height is total recorded time, peaking at {(peak / 3600).toFixed(0)} h. A short month
        is a short column: its mix is real but there is not enough of it to read a shape from.
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
        {ZONE_ORDER.map((zone) => (
          <span key={zone} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{ width: 10, height: 10, borderRadius: 2, background: ZONE_COLOR[zone], display: 'inline-block' }}
            />
            {ZONE_LABEL[zone]}
          </span>
        ))}
      </div>
    </div>
  );
}
