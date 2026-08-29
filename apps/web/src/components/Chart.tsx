import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';

/**
 * Increments whenever the effective colour scheme changes.
 *
 * Chart colours are read out of CSS custom properties into canvas paint calls,
 * so unlike DOM elements they do not restyle themselves when the theme flips.
 * Callers thread this through their options memo and into the chart, which
 * rebuilds against the new palette.
 */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);

    // Explicit toggle: the attribute on <html>.
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    // "System" setting: the OS preference changing under us.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', bump);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', bump);
    };
  }, []);

  return version;
}

/**
 * Thin React wrapper around uPlot.
 *
 * uPlot rather than an SVG charting library because these series are long: the
 * fitness model is ~2,000 daily points and a single ride stream is thousands
 * more. SVG charts allocate a DOM node per point and stop being interactive
 * well before that; uPlot draws to canvas and stays smooth.
 */
export function Chart({
  data,
  options,
  height = 260,
  themeVersion = 0,
}: {
  data: uPlot.AlignedData;
  options: Omit<uPlot.Options, 'width' | 'height'>;
  height?: number;
  /** From useThemeVersion(); rebuilds the canvas when the palette changes. */
  themeVersion?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const width = host.current.clientWidth || 600;
    const chart = new uPlot({ ...options, width, height } as uPlot.Options, data, host.current);
    plot.current = chart;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) chart.setSize({ width: entry.contentRect.width, height });
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      chart.destroy();
      plot.current = null;
    };
    // Options are rebuilt on every render, so they are deliberately not a
    // dependency: the chart rebuilds on data identity, size, or a palette
    // change, and nothing else.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, height, themeVersion]);

  return <div ref={host} style={{ width: '100%' }} />;
}

/** Reads a CSS custom property so charts follow the active theme. */
export function themeColor(name: string, fallback = '#888'): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}
