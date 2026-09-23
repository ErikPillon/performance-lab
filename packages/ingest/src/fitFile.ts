import { gunzipSync } from 'node:zlib';

/**
 * What counts as a FIT file on the way in: `.fit`, or the `.fit.gz` that Garmin
 * and Strava exports contain. A bare `.gz` is not enough — a Strava archive
 * also holds `.gpx.gz` and `.tcx.gz`, which the parser cannot read and which
 * would otherwise be stored, queued and failed one by one.
 */
export const FIT_FILENAME = /\.fit(\.gz)?$/i;

/**
 * A FIT file never legitimately inflates past this. Long ultra-distance
 * recordings are a few MB; the cap only exists so a crafted archive cannot
 * expand into the worker's memory.
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * The FIT bytes inside an upload, whether or not it arrived gzipped.
 *
 * Decided by the gzip magic number rather than the filename, so a renamed file
 * still works. Unwrapping happens before hashing and storage: gzip is transport
 * packaging, not part of the recording, and hashing the FIT itself means the
 * same activity uploaded as `.fit` and as `.fit.gz` dedupes to one raw file.
 */
export function unwrapFit(bytes: Buffer): Buffer {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  return gunzipSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES });
}
