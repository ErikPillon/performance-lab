import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Object storage for raw uploaded files.
 *
 * The client is built on first use rather than at module load, for the same
 * reason the job queues are: importing a module should not open a connection or
 * demand that credentials already be present. Reading configuration at call
 * time also means a missing S3_SECRET_KEY fails where it is used, with a stack
 * that points at the upload, instead of during an unrelated import.
 */

let client: S3Client | undefined;
let config: { bucket: string } | undefined;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

function s3(): { client: S3Client; bucket: string } {
  if (!client) {
    client = new S3Client({
      endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
      region: process.env.S3_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: required('S3_ACCESS_KEY'),
        secretAccessKey: required('S3_SECRET_KEY'),
      },
      forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
    });
    config = { bucket: process.env.S3_BUCKET ?? 'performance-lab' };
  }
  return { client, bucket: config!.bucket };
}

/** Whether a client has been built. Exported for tests. */
export function isConnected(): boolean {
  return client !== undefined;
}

async function exists(key: string): Promise<boolean> {
  const { client, bucket } = s3();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Store bytes unless already present. Returns true when a write happened. */
export async function putRaw(key: string, body: Buffer, contentType: string): Promise<boolean> {
  if (await exists(key)) return false;
  const { client, bucket } = s3();
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return true;
}
