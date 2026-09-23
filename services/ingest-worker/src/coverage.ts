import { eq } from 'drizzle-orm';
import { activity, activityTrack, coverageArea, db } from '@lab/db';
import { computeArea, discoverAreas, type TrackIn } from './analytics.js';

/**
 * Street coverage, refreshed in the background.
 *
 * The analytics service does the geometry and talks to OpenStreetMap; this
 * decides what to ask for and keeps the totals. Areas are found from the
 * tracks themselves — the communes that hold a meaningful share of the
 * athlete's GPS — and computed one at a time, each written as soon as it is
 * done, so a long first run shows progress rather than nothing until the end.
 */

export type CoverageGroup = 'foot' | 'bike' | 'all';

/** Sports whose tracks follow streets on foot or by bike. Swims do not. */
const GROUP_OF: Record<string, 'foot' | 'bike'> = {
  running: 'foot',
  walking: 'foot',
  hiking: 'foot',
  cycling: 'bike',
};

export function groupOf(sport: string): 'foot' | 'bike' | null {
  return GROUP_OF[sport] ?? null;
}

type Bbox = [number, number, number, number];

function overlaps(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export interface CoverageProgress {
  phase: 'discovering' | 'computing' | 'done';
  done: number;
  total: number;
  area?: string;
}

export async function refreshCoverage(
  athleteId: string,
  onProgress: (p: CoverageProgress) => Promise<void> | void = () => {},
): Promise<string> {
  const rows = await db
    .select({
      id: activityTrack.activityId,
      sport: activityTrack.sport,
      parts: activityTrack.parts,
      south: activityTrack.south,
      west: activityTrack.west,
      north: activityTrack.north,
      east: activityTrack.east,
      startTime: activityTrack.startTime,
      // Sector passes are timed from the full stream, not the simplified track.
      streamsKey: activity.streamsKey,
    })
    .from(activityTrack)
    .innerJoin(activity, eq(activity.id, activityTrack.activityId))
    .where(eq(activityTrack.athleteId, athleteId));

  const eligible = rows
    .map((r) => ({ ...r, group: groupOf(r.sport), bbox: [r.south, r.west, r.north, r.east] as Bbox }))
    .filter((r) => r.group !== null);
  if (eligible.length === 0) return 'no running, walking or cycling tracks';

  await onProgress({ phase: 'discovering', done: 0, total: 0 });
  const { areas } = await discoverAreas(eligible.map((r): TrackIn => ({ id: r.id, parts: r.parts })));

  let computed = 0;
  let failed = 0;
  for (const [i, area] of areas.entries()) {
    await onProgress({ phase: 'computing', done: i, total: areas.length, area: area.name });
    const near = eligible.filter((r) => overlaps(r.bbox, area.bbox));
    const groups: Record<CoverageGroup, string[]> = {
      foot: near.filter((r) => r.group === 'foot').map((r) => r.id),
      bike: near.filter((r) => r.group === 'bike').map((r) => r.id),
      all: near.map((r) => r.id),
    };
    try {
      const res = await computeArea(athleteId, area.id, groups, {
        tracks: near.map((r) => ({ id: r.id, parts: r.parts })),
        streams: Object.fromEntries(near.filter((r) => r.streamsKey).map((r) => [r.id, r.streamsKey!])),
        starts: Object.fromEntries(near.map((r) => [r.id, r.startTime.toISOString()])),
      });
      const [south, west, north, east] = area.bbox;
      for (const [group, t] of Object.entries(res.results)) {
        const values = {
          athleteId,
          group: group as CoverageGroup,
          osmId: area.id,
          name: area.name,
          adminLevel: area.level,
          south, west, north, east,
          share: area.share,
          lengthM: t.length_m,
          coveredM: t.covered_m,
          streets: t.streets,
          streetsDone: t.streets_done,
          subareas: t.subareas,
          activities: t.activities,
          sectors: t.sectors,
          computedAt: new Date(res.computed_at),
        };
        await db.insert(coverageArea).values(values).onConflictDoUpdate({
          target: [coverageArea.athleteId, coverageArea.group, coverageArea.osmId],
          set: values,
        });
      }
      computed++;
    } catch (err) {
      // One area OpenStreetMap could not serve must not cost the others.
      failed++;
      console.error(`[coverage] ${area.name} (${area.id}) failed:`, (err as Error).message);
    }
  }

  await onProgress({ phase: 'done', done: areas.length, total: areas.length });
  return `${computed} areas computed, ${failed} failed, from ${eligible.length} tracks`;
}
