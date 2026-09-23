import { and, asc, desc, eq, gte, inArray, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { activityTrack, coverageArea, db } from '@lab/db';
import { coverageJobId, coverageQueue, requestCoverageRefresh } from '@lab/jobs';
import { env } from '../env.js';
import { requireAthleteAccess } from '../access.js';

/**
 * Maps across a whole history: the heatmap, and street coverage by commune.
 *
 * Every route here needs the `location` scope, not just `training`. A single
 * route shows where someone ran once; every route together shows where they
 * live, work and sleep, which is exactly what that scope exists to withhold.
 */

type Group = 'foot' | 'bike' | 'all';

const GROUP_SPORTS: Record<Group, ('running' | 'walking' | 'hiking' | 'cycling')[]> = {
  foot: ['running', 'walking', 'hiking'],
  bike: ['cycling'],
  all: ['running', 'walking', 'hiking', 'cycling'],
};

function group(value: string | undefined): Group {
  return value === 'foot' || value === 'bike' ? value : 'all';
}

function date(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function mapRoutes(app: FastifyInstance) {
  /**
   * Every simplified route in a date range, for the heatmap.
   *
   * The whole history ships in one response on purpose. Simplified and
   * polyline-encoded, a few hundred sessions are well under a megabyte, and
   * the map then filters and redraws without another round trip.
   */
  app.get<{ Params: { id: string }; Querystring: { group?: string; from?: string; to?: string } }>(
    '/athletes/:id/tracks',
    async (req) => {
      await requireAthleteAccess(req, req.params.id, 'location');
      const from = date(req.query.from);
      const to = date(req.query.to);
      const rows = await db
        .select({
          id: activityTrack.activityId,
          sport: activityTrack.sport,
          startTime: activityTrack.startTime,
          parts: activityTrack.parts,
        })
        .from(activityTrack)
        .where(and(
          eq(activityTrack.athleteId, req.params.id),
          inArray(activityTrack.sport, GROUP_SPORTS[group(req.query.group)]),
          from ? gte(activityTrack.startTime, from) : undefined,
          to ? lt(activityTrack.startTime, new Date(to.getTime() + 86_400_000)) : undefined,
        ))
        .orderBy(asc(activityTrack.startTime));
      return { tracks: rows };
    },
  );

  /** Coverage totals per commune, and where the background refresh stands. */
  app.get<{ Params: { id: string }; Querystring: { group?: string } }>(
    '/athletes/:id/coverage',
    async (req) => {
      const access = await requireAthleteAccess(req, req.params.id, 'location');
      const areas = await db
        .select()
        .from(coverageArea)
        .where(and(
          eq(coverageArea.athleteId, req.params.id),
          eq(coverageArea.group, group(req.query.group)),
        ))
        .orderBy(desc(coverageArea.share));

      const job = await coverageQueue().getJob(coverageJobId(req.params.id));
      const state = job ? await job.getState() : null;
      return {
        areas,
        refresh: job && state !== 'completed'
          ? { state, progress: job.progress, failedReason: job.failedReason ?? null }
          : null,
        canRefresh: access.relationship === 'owner',
      };
    },
  );

  /** Recompute now instead of waiting for the next activity. */
  app.post<{ Params: { id: string } }>('/athletes/:id/coverage/refresh', async (req, reply) => {
    const access = await requireAthleteAccess(req, req.params.id, 'location');
    if (access.relationship !== 'owner') {
      return reply.code(403).send({ error: 'only the athlete can refresh their coverage' });
    }
    await requestCoverageRefresh(req.params.id, 0);
    return reply.code(202).send({ queued: true });
  });

  /**
   * One commune in full: its outline, every covered and uncovered stretch of
   * street, and the per-street and per-neighbourhood breakdown.
   */
  app.get<{ Params: { id: string; osmId: string }; Querystring: { group?: string } }>(
    '/athletes/:id/coverage/:osmId',
    async (req, reply) => {
      await requireAthleteAccess(req, req.params.id, 'location');
      const osmId = Number(req.params.osmId);
      if (!Number.isSafeInteger(osmId) || osmId <= 0) {
        return reply.code(400).send({ error: 'bad area id' });
      }
      const params = new URLSearchParams({
        athlete_id: req.params.id,
        group: group(req.query.group),
        osm_id: String(osmId),
      });
      const res = await fetch(`${env.analyticsUrl}/coverage/detail?${params}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return reply.code(404).send({ error: 'not computed yet' });
      if (!res.ok) return reply.code(502).send({ error: `analytics ${res.status}` });
      return res.json();
    },
  );
}
