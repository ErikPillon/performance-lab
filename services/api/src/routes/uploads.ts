import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ingestBytes } from '@lab/ingest';
import { env } from '../env.js';
import { requireAthleteAccess } from '../access.js';

/**
 * Browser upload.
 *
 * This route used to live on the ingest worker, which put the only write path
 * into the system on a second HTTP surface. The edge proxy only ever forwarded
 * `/api/*` to this service, so in a real deployment the upload endpoint was not
 * reachable at all — importing was CLI-only whether or not anyone intended that.
 *
 * The heavy work still belongs to the worker. This handler only hashes, stores
 * and enqueues; parsing happens off the request, which is why a 25 MB file
 * returns in well under a second and a bad file cannot take the API down.
 */

/** Extensions the pipeline can actually decode. */
const ACCEPTED = new Set(['fit', 'gz']);

export async function uploadRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      fileSize: env.maxUploadBytes,
      // A cap on count as well as size: twenty 25 MB files is already 500 MB
      // of request, and a season's export is better done through the backfill.
      files: 20,
    },
  });

  app.post<{ Params: { id: string } }>('/athletes/:id/files', async (req, reply) => {
    // Uploading writes training data, so this needs the same scope as reading
    // it — a coach with read access must not be able to inject activities.
    const access = await requireAthleteAccess(req, req.params.id);
    if (access.relationship !== 'owner') {
      return reply.code(403).send({ error: 'only the athlete can upload files' });
    }

    const results: {
      filename: string;
      status: 'queued' | 'duplicate' | 'rejected';
      rawFileId?: string;
      sha256?: string;
      reason?: string;
    }[] = [];

    for await (const part of req.files()) {
      const extension = part.filename.split('.').pop()?.toLowerCase() ?? '';
      if (!ACCEPTED.has(extension)) {
        // Drain the stream even when rejecting: an unread part blocks the ones
        // behind it, so a single .jpg would hang the rest of the upload.
        await part.toBuffer();
        results.push({
          filename: part.filename,
          status: 'rejected',
          reason: `${extension || 'no extension'} is not a FIT file`,
        });
        continue;
      }

      try {
        const bytes = await part.toBuffer();
        const outcome = await ingestBytes({
          athleteId: req.params.id,
          bytes,
          filename: part.filename,
          contentType: part.mimetype,
        });
        results.push({ filename: part.filename, ...outcome });
      } catch (err) {
        // One bad file should not lose the other nineteen, so failures are
        // reported per file rather than failing the whole request.
        req.log.error({ err, filename: part.filename }, 'upload failed');
        results.push({
          filename: part.filename,
          status: 'rejected',
          reason: err instanceof Error ? err.message : 'could not be stored',
        });
      }
    }

    if (results.length === 0) return reply.code(400).send({ error: 'no files in request' });

    // 202, not 200: the files are accepted and queued, and none of them have
    // been parsed yet. The client polls ingest status to watch them land.
    return reply.code(202).send({
      accepted: results,
      queued: results.filter((r) => r.status === 'queued').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
    });
  });
}
