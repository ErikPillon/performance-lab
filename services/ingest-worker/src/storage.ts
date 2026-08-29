import { PutObjectCommand, S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env.js';

export { rawKey, sha256 } from './keys.js';

export const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
  forcePathStyle: env.s3.forcePathStyle,
});

async function exists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Store bytes unless already present. Returns true when a write happened. */
export async function putRaw(key: string, body: Buffer, contentType: string): Promise<boolean> {
  if (await exists(key)) return false;
  await s3.send(
    new PutObjectCommand({ Bucket: env.s3.bucket, Key: key, Body: body, ContentType: contentType }),
  );
  return true;
}
