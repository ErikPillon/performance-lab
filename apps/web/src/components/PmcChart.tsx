import { useMemo } from 'react';
import type uPlot from 'uplot';
import type { PmcDay } from '../lib/api';
import { Chart, themeColor, useThemeVersion } from './Chart';

/**
 * An optional wellness series drawn over the model.
 *
 * On its own scale and axis, because the whole point is to read a 40-60 bpm
 * resting heart rate against a 0-100 fitness curve. Sharing an axis would
 * flatten one of them into a straight line.
 */
export interface PmcOverlay {
  label: string;
  unit: string;
  /** Value per ISO date; missing days are simply absent. */
  byDate: Map<string, number | null>;
  color: string;
}

/**
 * Fitness, fatigue and form over time.
 *
 * Daily load is drawn as faint bars behind the curves: the individual sessions
 * are what produced the shape, and hiding them makes the model look like it
 * arrived from nowhere.
 */
export function PmcChart({
  series,
  height = 300,
  overlay,
}: {
  series: PmcDay[];
  height?: number;
  overlay?: PmcOverlay;
}) {
  const themeVersion = useThemeVersion();
  const data = useMemo<uPlot.AlignedData>(() => {
    const x = series.map((d) => new Date(`${d.date}T00:00:00Z`).getTime() / 1000);
    return [
      x,
      series.map((d) => d.load || null),
      series.map((d) => d.ctl),
      series.map((d) => d.atl),
      series.map((d) => d.tsb),
      // Always present as a channel so the series list and the data stay the
      // same length; all-null when there is no overlay, which uPlot draws as
      // nothing.
      series.map((d) => (overlay ? (overlay.byDate.get(d.date) ?? null) : null)),
    ];
  }, [series, overlay]);

  const options = useMemo<Omit<uPlot.Options, 'width' | 'height'>>(() => {
    const grid = { stroke: themeColor('--grid', '#eee'), width: 1 };
    const axisText = themeColor('--faint', '#888');

    return {
      cursor: { drag: { x: true, y: false }, points: { size: 6 } },
      legend: { show: false },
      scales: {
        x: { time: true },
        load: { range: (_u, _min, max) => [0, Math.max(max * 3, 10)] },
        // Padded rather than tight to the data: a resting heart rate varying
        // over four beats would otherwise fill the full height and read as a
        // dramatic swing.
        overlay: {
          range: (_u, min, max) =>
            Number.isFinite(min) && Number.isFinite(max)
              ? [min - (max - min || 2) * 0.6, max + (max - min || 2) * 0.6]
              : [0, 1],
        },
      },
      axes: [
        { stroke: axisText, grid, ticks: grid },
        { scale: 'y', stroke: axisText, grid, ticks: grid, size: 44 },
        { scale: 'load', show: false },
        {
          scale: 'overlay',
          show: !!overlay,
          side: 1,
          stroke: overlay?.color ?? axisText,
          // No grid: a second set of horizontal lines over the first is noise.
          grid: { show: false },
          ticks: { show: false },
          size: 44,
        },
      ],
      series: [
        { label: 'date' },
        {
          label: 'Load',
          scale: 'load',
          // Bars behind everything, drawn as thin paths so a dense multi-year
          // range stays readable rather than turning into a solid block.
          paths: (u, i, i0, i1) => {
            const path = new Path2D();
            for (let j = i0; j <= i1; j++) {
              const v = u.data[i][j];
              if (v == null) continue;
              const px = Math.round(u.valToPos(u.data[0][j]!, 'x', true));
              path.moveTo(px, Math.round(u.valToPos(0, 'load', true)));
              path.lineTo(px, Math.round(u.valToPos(v as number, 'load', true)));
            }
            return { stroke: path };
          },
          stroke: themeColor('--border-strong', '#ccc'),
          width: 1.5,
          points: { show: false },
        },
        {
          label: 'Fitness (CTL)',
          scale: 'y',
          stroke: themeColor('--ctl', '#2563eb'),
          width: 2,
          fill: `${themeColor('--ctl', '#2563eb')}1a`,
          points: { show: false },
        },
        {
          label: 'Fatigue (ATL)',
          scale: 'y',
          stroke: themeColor('--atl', '#f97316'),
          width: 1.5,
          points: { show: false },
        },
        {
          label: 'Form (TSB)',
          scale: 'y',
          stroke: themeColor('--tsb', '#7c3aed'),
          width: 1.5,
          dash: [4, 3],
          points: { show: false },
        },
        {
          label: overlay?.label ?? 'overlay',
          scale: 'overlay',
          stroke: overlay?.color ?? 'transparent',
          width: 2,
          points: { show: false },
          // Breaks across days with no reading rather than interpolating a
          // measurement that was never taken.
          spanGaps: false,
        },
      ],
    };
  }, [themeVersion, overlay]);

  if (series.length === 0) {
    return <Empty>No fitness model yet — run the recompute to build one.</Empty>;
  }
  return <Chart data={data} options={options} height={height} themeVersion={themeVersion} />;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        placeItems: 'center',
        minHeight: 120,
        color: 'var(--faint)',
        fontSize: 13,
        padding: 24,
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  );
}

export function PmcLegend() {
  const items = [
    { label: 'Fitness (CTL)', color: 'var(--ctl)' },
    { label: 'Fatigue (ATL)', color: 'var(--atl)' },
    { label: 'Form (TSB)', color: 'var(--tsb)', dashed: true },
    { label: 'Daily load', color: 'var(--border-strong)' },
  ];
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--muted)' }}>
      {items.map((i) => (
        <span key={i.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 14,
              height: 0,
              borderTop: `2px ${i.dashed ? 'dashed' : 'solid'} ${i.color}`,
              display: 'inline-block',
            }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}
