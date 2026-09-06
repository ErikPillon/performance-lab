import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db, race, trainingBlock } from '@lab/db';
import { requireAthleteAccess } from '../access.js';
import {
  blockAdvisories, validateBlock, validateRace,
  type BlockInput, type RaceInput,
} from '../seasonRules.js';

/**
 * Races and periodisation blocks.
 *
 * Reads sit under the `training` scope so a coach can see the plan. Writes are
 * the athlete's alone for now — a coach composing an athlete's season is the
 * point of the coach relationship, but it is also a larger permission question
 * than this slice answers, and the safe default is the reversible one.
 */

export async function seasonRoutes(app: FastifyInstance) {
  /** Everything needed to draw a season, in one round trip. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/athletes/:id/season',
    async (req) => {
      await requireAthleteAccess(req, req.params.id);

      const raceFilters = [eq(race.athleteId, req.params.id)];
      if (req.query.from) raceFilters.push(gte(race.date, req.query.from));
      if (req.query.to) raceFilters.push(lte(race.date, req.query.to));

      const blockFilters = [eq(trainingBlock.athleteId, req.params.id)];
      // A block overlapping the window counts as inside it: one running from
      // before `from` to after `to` is the most relevant block there is, and a
      // naive range test on startDate would drop exactly that one.
      if (req.query.to) blockFilters.push(lte(trainingBlock.startDate, req.query.to));
      if (req.query.from) blockFilters.push(gte(trainingBlock.endDate, req.query.from));

      const [races, blocks] = await Promise.all([
        db.select().from(race).where(and(...raceFilters)).orderBy(asc(race.date)),
        db.select().from(trainingBlock).where(and(...blockFilters))
          .orderBy(asc(trainingBlock.startDate)),
      ]);
      return { races, blocks };
    },
  );

  async function requireOwnership(req: Parameters<typeof requireAthleteAccess>[0], id: string) {
    const access = await requireAthleteAccess(req, id);
    return access.relationship === 'owner';
  }

  app.post<{ Params: { id: string }; Body: RaceInput }>(
    '/athletes/:id/races',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateRace(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      const [created] = await db.insert(race).values({
        athleteId: req.params.id,
        date: req.body.date!,
        name: req.body.name!.trim(),
        sport: (req.body.sport ?? 'running') as never,
        priority: (req.body.priority ?? 'B') as never,
        distanceM: req.body.distanceM ?? null,
        goalTimeS: req.body.goalTimeS ?? null,
        resultTimeS: req.body.resultTimeS ?? null,
        note: req.body.note?.trim() || null,
      }).returning();
      return reply.code(201).send({ race: created });
    },
  );

  app.patch<{ Params: { id: string; raceId: string }; Body: RaceInput }>(
    '/athletes/:id/races/:raceId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateRace(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      // Scoped by athlete as well as id: an id alone would let anyone with a
      // uuid edit someone else's race.
      const [updated] = await db.update(race).set({
        date: req.body.date!,
        name: req.body.name!.trim(),
        sport: (req.body.sport ?? 'running') as never,
        priority: (req.body.priority ?? 'B') as never,
        distanceM: req.body.distanceM ?? null,
        goalTimeS: req.body.goalTimeS ?? null,
        resultTimeS: req.body.resultTimeS ?? null,
        note: req.body.note?.trim() || null,
      }).where(and(eq(race.id, req.params.raceId), eq(race.athleteId, req.params.id)))
        .returning();
      if (!updated) return reply.code(404).send({ error: 'no such race' });
      return reply.send({ race: updated });
    },
  );

  app.delete<{ Params: { id: string; raceId: string } }>(
    '/athletes/:id/races/:raceId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const deleted = await db.delete(race)
        .where(and(eq(race.id, req.params.raceId), eq(race.athleteId, req.params.id)))
        .returning({ id: race.id });
      return reply.send({ deleted: deleted.length });
    },
  );

  app.post<{ Params: { id: string }; Body: BlockInput }>(
    '/athletes/:id/blocks',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateBlock(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      const [created] = await db.insert(trainingBlock).values({
        athleteId: req.params.id,
        name: req.body.name!.trim(),
        focus: (req.body.focus ?? 'base') as never,
        startDate: req.body.startDate!,
        endDate: req.body.endDate!,
        targetWeeklyLoad: req.body.targetWeeklyLoad ?? null,
        raceId: req.body.raceId ?? null,
        note: req.body.note?.trim() || null,
      }).returning();
      return reply.code(201).send({ block: created, advisories: blockAdvisories(req.body) });
    },
  );

  app.patch<{ Params: { id: string; blockId: string }; Body: BlockInput }>(
    '/athletes/:id/blocks/:blockId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const errors = validateBlock(req.body ?? {});
      if (errors.length) return reply.code(400).send({ error: errors.join('; '), errors });

      const [updated] = await db.update(trainingBlock).set({
        name: req.body.name!.trim(),
        focus: (req.body.focus ?? 'base') as never,
        startDate: req.body.startDate!,
        endDate: req.body.endDate!,
        targetWeeklyLoad: req.body.targetWeeklyLoad ?? null,
        raceId: req.body.raceId ?? null,
        note: req.body.note?.trim() || null,
      }).where(and(
        eq(trainingBlock.id, req.params.blockId),
        eq(trainingBlock.athleteId, req.params.id),
      )).returning();
      if (!updated) return reply.code(404).send({ error: 'no such block' });
      return reply.send({ block: updated, advisories: blockAdvisories(req.body) });
    },
  );

  app.delete<{ Params: { id: string; blockId: string } }>(
    '/athletes/:id/blocks/:blockId',
    async (req, reply) => {
      if (!(await requireOwnership(req, req.params.id))) {
        return reply.code(403).send({ error: 'only the athlete can plan their season' });
      }
      const deleted = await db.delete(trainingBlock)
        .where(and(
          eq(trainingBlock.id, req.params.blockId),
          eq(trainingBlock.athleteId, req.params.id),
        ))
        .returning({ id: trainingBlock.id });
      return reply.send({ deleted: deleted.length });
    },
  );
}
