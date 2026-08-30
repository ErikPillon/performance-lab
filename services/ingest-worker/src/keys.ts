import { createHash } from 'node:crypto';

/**
 * Content addressing. Deliberately free of configuration imports so it can be
 * reasoned about and tested without a database or object store in reach.
 */

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Content-addressed key. The two-character prefix keeps any single directory
 * listing small on filesystem-backed stores, and the hash makes the write
 * idempotent: the same bytes always land on the same key.
 */
export function rawKey(hash: string, ext = 'fit'): string {
  return `raw/${hash.slice(0, 2)}/${hash}.${ext}`;
}
