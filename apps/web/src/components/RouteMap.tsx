import L from 'leaflet';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { StreamPayload } from '../lib/api';
import { themeColor, useThemeVersion } from './Chart';

/**
 * Route map for a GPS activity.
 *
 * Leaflet rather than a vector-tile engine: this needs raster tiles and a
 * polyline, which Leaflet does in ~42 kB with no WebGL, no worker and no
 * animation-frame dependency. MapLibre would earn its ~250 kB for vector
 * basemaps, terrain or rotation — none of which a route view uses.
 *
 * The line is drawn from our own stored coordinates, so the route always
 * renders; the basemap underneath is a convenience that degrades to an empty
 * background if tiles cannot be fetched. That ordering matters on a home server
 * that may be offline or firewalled — a missing basemap should not cost you the
 * route.
 *
 * Tiles come from a public OpenStreetMap endpoint by default, which means the
 * area being viewed is visible to that provider. Point VITE_MAP_TILES at your
 * own tile server to keep route locations local.
 */

const TILE_URL =
  import.meta.env.VITE_MAP_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export type ColorBy = 'speed_mps' | 'altitude_m' | 'heart_rate' | 'none';

/** Colour bands. Segments are bucketed into these rather than drawn one line
 *  each: a 1,400-point track would otherwise be 1,400 Leaflet layers. */
const BANDS = 8;

interface Point {
  lat: number;
  lon: number;
  t: number;
  value: number | null;
}

function bandColor(index: number, total: number): string {
  const t = total <= 1 ? 0 : index / (total - 1);
  // Cool -> warm, matching the load/intensity language used elsewhere.
  const from = themeColor('--ctl', '#2563eb');
  const mid = themeColor('--warn', '#d97706');
  const to = themeColor('--bad', '#dc2626');
  return t < 0.5 ? mix(from, mid, t * 2) : mix(mid, to, (t - 0.5) * 2);
}

function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => {
    const clean = hex.replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  try {
    const [r1, g1, b1] = parse(a);
    const [r2, g2, b2] = parse(b);
    const c = (x: number, y: number) => Math.round(x + (y - x) * t);
    return `rgb(${c(r1!, r2!)}, ${c(g1!, g2!)}, ${c(b1!, b2!)})`;
  } catch {
    return a;
  }
}

export function RouteMap({
  payload,
  colorBy = 'speed_mps',
  cursorT,
  height,
}: {
  payload: StreamPayload;
  colorBy?: ColorBy;
  /** Elapsed seconds the charts are hovering, for a synced marker. */
  cursorT?: number | null;
  /** Fixed height; omit to size the panel to the route's own shape. */
  height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.CircleMarker | null>(null);
  const themeVersion = useThemeVersion();
  const [tilesFailed, setTilesFailed] = useState(false);

  const points = useMemo<Point[]>(() => {
    const { lat, lon, t_s } = payload.series;
    if (!lat || !lon) return [];
    const values = colorBy === 'none' ? null : payload.series[colorBy];
    const out: Point[] = [];
    for (let i = 0; i < lat.length; i++) {
      const la = lat[i];
      const lo = lon[i];
      if (la == null || lo == null) continue;
      out.push({ lat: la, lon: lo, t: t_s?.[i] ?? i, value: values?.[i] ?? null });
    }
    return out;
  }, [payload, colorBy]);

  /**
   * Height from the route's own proportions.
   *
   * A fixed wide panel frames a north-south out-and-back terribly: one route
   * here spans 9.1 km by 1.9 km, and in a 3:1 panel the fit is driven by height
   * so most of the width is empty map. Taller routes get a taller panel, within
   * bounds that keep the page readable.
   */
  const autoHeight = useMemo(() => {
    if (points.length < 2) return 380;
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const heightKm = (Math.max(...lats) - Math.min(...lats)) * 111;
    const widthKm =
      (Math.max(...lons) - Math.min(...lons)) * 111 * Math.cos((midLat * Math.PI) / 180);
    if (widthKm < 0.05) return 480;
    // Assume roughly 1100px of panel width and match the route's aspect,
    // clamped so a very long or very flat route stays a sensible panel.
    return Math.round(Math.min(560, Math.max(320, (1100 * heightKm) / widthKm)));
  }, [points]);

  useEffect(() => {
    if (!host.current || points.length < 2) return;

    const dark =
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.hasAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);

    const instance = L.map(host.current, {
      zoomControl: true,
      // Page scroll should not zoom the map out from under the reader.
      scrollWheelZoom: false,
      attributionControl: true,
      // Fractional zoom. Leaflet's default snaps fitBounds down to a whole
      // level, which for a narrow out-and-back in a wide panel framed a 9 km
      // route inside a 60 km view — almost a full level of waste.
      zoomSnap: 0,
    });
    map.current = instance;

    const tiles = L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
      className: dark ? 'map-tiles-dark' : undefined,
    });
    tiles.on('tileerror', () => setTilesFailed(true));
    tiles.addTo(instance);

    // One canvas for every segment layer, so the whole track is a single
    // surface rather than hundreds of DOM nodes.
    const renderer = L.canvas({ padding: 0.3 });

    const values = points.map((p) => p.value).filter((v): v is number => v != null);
    const lo = values.length ? Math.min(...values) : 0;
    const hi = values.length ? Math.max(...values) : 1;
    const span = hi - lo || 1;
    const uniform = colorBy === 'none' || values.length === 0;

    // Casing first, so the coloured track sits on top of it.
    const latlngs = points.map((p) => [p.lat, p.lon] as [number, number]);
    L.polyline(latlngs, {
      renderer,
      color: dark ? '#000' : '#fff',
      weight: 7,
      opacity: 0.5,
      lineJoin: 'round',
    }).addTo(instance);

    if (uniform) {
      L.polyline(latlngs, { renderer, color: themeColor('--accent', '#2563eb'), weight: 3.5 }).addTo(instance);
    } else {
      const buckets: [number, number][][][] = Array.from({ length: BANDS }, () => []);
      for (let i = 0; i < points.length - 1; i++) {
        const p = points[i]!;
        const q = points[i + 1]!;
        const intensity = p.value == null ? 0.5 : (p.value - lo) / span;
        const band = Math.min(BANDS - 1, Math.max(0, Math.floor(intensity * BANDS)));
        buckets[band]!.push([
          [p.lat, p.lon],
          [q.lat, q.lon],
        ]);
      }
      buckets.forEach((segments, band) => {
        if (segments.length === 0) return;
        // A multi-polyline: many disjoint segments, one layer.
        L.polyline(segments, { renderer, color: bandColor(band, BANDS), weight: 3.5, lineCap: 'round' }).addTo(
          instance,
        );
      });
    }

    const start = points[0]!;
    const finish = points[points.length - 1]!;
    L.circleMarker([start.lat, start.lon], {
      renderer,
      radius: 6,
      color: '#fff',
      weight: 2,
      fillColor: themeColor('--good', '#059669'),
      fillOpacity: 1,
    })
      .bindTooltip('Start')
      .addTo(instance);
    L.circleMarker([finish.lat, finish.lon], {
      renderer,
      radius: 6,
      color: '#fff',
      weight: 2,
      fillColor: themeColor('--bad', '#dc2626'),
      fillOpacity: 1,
    })
      .bindTooltip('Finish')
      .addTo(instance);

    const bounds = L.latLngBounds(latlngs);
    instance.fitBounds(bounds, { padding: [28, 28] });

    // Leaflet measures its container on creation; inside a panel that is still
    // laying out that measurement is wrong, and a fit against the wrong size
    // lands on the wrong zoom — here the whole country instead of the route.
    // Re-fit once on the first real measurement, then only resize after that so
    // the reader's own panning is not undone.
    let fitted = false;
    const observer = new ResizeObserver(() => {
      instance.invalidateSize({ animate: false });
      if (!fitted) {
        instance.fitBounds(bounds, { padding: [28, 28] });
        fitted = true;
      }
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      marker.current = null;
      instance.remove();
      map.current = null;
    };
  }, [points, colorBy, themeVersion]);

  // Move the synced marker without rebuilding the map.
  useEffect(() => {
    const instance = map.current;
    if (!instance || points.length === 0) return;

    if (cursorT == null) {
      if (marker.current) {
        marker.current.remove();
        marker.current = null;
      }
      return;
    }

    let nearest = points[0]!;
    let best = Infinity;
    for (const p of points) {
      const delta = Math.abs(p.t - cursorT);
      if (delta < best) {
        best = delta;
        nearest = p;
      }
    }

    if (!marker.current) {
      marker.current = L.circleMarker([nearest.lat, nearest.lon], {
        radius: 7,
        color: themeColor('--panel', '#fff'),
        weight: 3,
        fillColor: themeColor('--accent', '#2563eb'),
        fillOpacity: 1,
      }).addTo(instance);
    } else {
      marker.current.setLatLng([nearest.lat, nearest.lon]);
    }
  }, [cursorT, points]);

  if (points.length < 2) return null;

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={host}
        style={{
          width: '100%',
          height: height ?? autoHeight,
          borderRadius: 8,
          overflow: 'hidden',
          background: 'var(--panel-2)',
        }}
      />
      {tilesFailed && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            zIndex: 500,
            fontSize: 11,
            color: 'var(--muted)',
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '3px 8px',
          }}
        >
          Basemap unavailable — the route is drawn from your own data.
        </div>
      )}
    </div>
  );
}
