import { and, eq } from 'drizzle-orm';
import { db, rawFile } from '@lab/db';
import { parseQueue, type ParseJob } from '@lab/jobs';
import { putRaw } from './storage.js';
import { rawKey, sha256 } from './keys.js';

export interface IngestResult {
  rawFileId: string;
  sha256: string;
  status: 'queued' | 'duplicate';
}

export { rawKey, sha256 } from './keys.js';
export { isConnected, putRaw } from './storage.js';

/**
 * Accept a file into the pipeline.
 *
 * Idempotent by content hash: re-ingesting the same bytes is a cheap no-op
 * rather than a duplicate activity. That property is what makes a backfill
 * safe to re-run after a crash, and what stops a Strava webhook redelivery
 * from double-counting training load.
 */
export async function ingestBytes(opts: {
  athleteId: string;
  bytes: Buffer;
  filename?: string;
  source?: 'upload' | 'strava' | 'garmin' | 'manual';
  contentType?: string;
}): Promise<IngestResult> {
  const { athleteId, bytes, filename, source = 'upload' } = opts;
  const hash = sha256(bytes);

  const [existing] = await db
    .select({ id: rawFile.id })
    .from(rawFile)
    .where(and(eq(rawFile.athleteId, athleteId), eq(rawFile.sha256, hash)))
    .limit(1);

  if (existing) return { rawFileId: existing.id, sha256: hash, status: 'duplicate' };

  const key = rawKey(hash);
  await putRaw(key, bytes, opts.contentType ?? 'application/vnd.ant.fit');

  // The unique index on (athlete_id, sha256) is the real guard: two concurrent
  // uploads of the same file race past the SELECT above, and one of them loses
  // here rather than creating a second row.
  const inserted = await db
    .insert(rawFile)
    .values({
      athleteId,
      sha256: hash,
      source,
      originalFilename: filename ?? null,
      contentType: opts.contentType ?? 'application/vnd.ant.fit',
      byteSize: bytes.byteLength,
      blobKey: key,
      status: 'pending',
    })
    .onConflictDoNothing({ target: [rawFile.athleteId, rawFile.sha256] })
    .returning({ id: rawFile.id });

  const row = inserted[0];
  if (!row) {
    const [winner] = await db
      .select({ id: rawFile.id })
      .from(rawFile)
      .where(and(eq(rawFile.athleteId, athleteId), eq(rawFile.sha256, hash)))
      .limit(1);
    return { rawFileId: winner!.id, sha256: hash, status: 'duplicate' };
  }

  const job: ParseJob = { rawFileId: row.id, athleteId, blobKey: key, source };
  // Job id = raw file id, so a redelivered webhook or a retried backfill
  // collapses onto one queued job instead of fanning out.
  await parseQueue().add('parse', job, { jobId: row.id });

  return { rawFileId: row.id, sha256: hash, status: 'queued' };
}
