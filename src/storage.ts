import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Screenshots } from './parser';

// S3 offloading keeps callback bodies small:
//  - the result JSON is PRIVATE, delivered via a short-lived presigned GET URL;
//  - screenshots are PUBLIC binary objects under the `screenshots/` prefix, delivered
//    as permanent direct S3 URLs (no signing).
// When S3_BUCKET is unset the feature is off and callers inline the payload / base64
// screenshots (local dev needs no AWS at all).

const BUCKET = process.env.S3_BUCKET;
const REGION = process.env.AWS_REGION;
// How long the presigned GET URL for the (private) result payload stays valid. Default 1h —
// the backend fetches it once on callback receipt and stores the parsed result in its DB.
const URL_TTL_SECONDS = parseInt(process.env.S3_URL_TTL_SECONDS ?? '3600', 10);
// Base URL for the PUBLIC screenshot objects. Defaults to the direct S3 endpoint; set to a
// CloudFront domain to swap in a CDN with no code change.
const PUBLIC_BASE = process.env.S3_PUBLIC_BASE_URL
  || `https://${BUCKET}.s3.${REGION ?? 'us-east-1'}.amazonaws.com`;

// Lazily created so importing this module never touches AWS when disabled.
let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client(REGION ? { region: REGION } : {});
  return client;
}

export function s3Enabled(): boolean {
  return !!BUCKET;
}

// Signs a GET URL for an existing key. Pure crypto — never contacts S3.
export async function presignGet(key: string, ttlSeconds: number = URL_TTL_SECONDS): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: ttlSeconds,
  });
}

// Uploads `body` as JSON under `key` (private) and returns a presigned GET URL.
export async function uploadPayload(key: string, body: unknown): Promise<string> {
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(body),
    ContentType: 'application/json',
  }));
  return presignGet(key);
}

// The permanent public URL for a screenshot object (read access via the bucket policy on `screenshots/`).
export function publicUrl(key: string): string {
  return `${PUBLIC_BASE}/${key}`;
}

const DATA_URI_RE = /^data:(image\/[A-Za-z0-9.+-]+);base64,(.+)$/s;

// Decodes a base64 image data URI and uploads the raw bytes with the right ContentType.
// No ACL — public read comes from the bucket policy scoped to the `screenshots/` prefix.
export async function uploadImage(key: string, dataUri: string): Promise<void> {
  const m = DATA_URI_RE.exec(dataUri);
  if (!m) throw new Error('unsupported screenshot data URI');
  await s3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: Buffer.from(m[2], 'base64'),
    ContentType: m[1],
  }));
}

// image/jpeg -> jpg, image/webp -> webp, image/png -> png, etc.
function extFor(dataUri: string): string {
  const sub = (/^data:image\/([A-Za-z0-9.+-]+);/.exec(dataUri)?.[1] ?? 'jpeg').toLowerCase();
  return sub === 'jpeg' ? 'jpg' : sub;
}

// Uploads every present screenshot under `keyPrefix` (concurrently) and returns a new
// Screenshots object with the base64 data replaced by permanent public URLs.
export async function offloadScreenshots(keyPrefix: string, s: Screenshots): Promise<Screenshots> {
  const uploads: Promise<void>[] = [];
  const out: Screenshots = { storage: 's3', final: null, fullPage: null, filmstrip: [] };

  if (s.final) {
    const key = `${keyPrefix}/final.${extFor(s.final)}`;
    uploads.push(uploadImage(key, s.final));
    out.final = publicUrl(key);
  }
  if (s.fullPage) {
    const key = `${keyPrefix}/fullpage.${extFor(s.fullPage)}`;
    uploads.push(uploadImage(key, s.fullPage));
    out.fullPage = publicUrl(key);
  }
  out.filmstrip = s.filmstrip.map((frame, i) => {
    const key = `${keyPrefix}/filmstrip-${i}.${extFor(frame.data)}`;
    uploads.push(uploadImage(key, frame.data));
    return { timing: frame.timing, data: publicUrl(key) };
  });

  await Promise.all(uploads);
  return out;
}
