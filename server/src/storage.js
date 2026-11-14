import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const cfg = config.storage;
let s3 = null;
let sdk = null;
let presigner = null;

async function initS3() {
  if (s3) return;
  sdk = await import('@aws-sdk/client-s3');
  presigner = await import('@aws-sdk/s3-request-presigner');
  s3 = new sdk.S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    // Credentials come from the default AWS provider chain:
    // env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), ~/.aws/credentials, or an EC2/ECS IAM role.
  });
}

if (cfg.driver === 'local') fs.mkdirSync(cfg.localDir, { recursive: true });

export const storageDriver = cfg.driver;

export async function putObject(key, buffer, mime) {
  if (cfg.driver === 's3') {
    await initS3();
    await s3.send(
      new sdk.PutObjectCommand({
        Bucket: cfg.bucket,
        Key: cfg.prefix + key,
        Body: buffer,
        ContentType: mime,
        ServerSideEncryption: 'AES256',
      }),
    );
  } else {
    await fs.promises.writeFile(path.join(cfg.localDir, key), buffer);
  }
}

/** Startup check: confirms the bucket is reachable with the current credentials. */
export async function checkStorage() {
  if (cfg.driver !== 's3') return { ok: true, driver: 'local', detail: cfg.localDir };
  try {
    await initS3();
    await s3.send(new sdk.HeadBucketCommand({ Bucket: cfg.bucket }));
    return { ok: true, driver: 's3', detail: `s3://${cfg.bucket}/${cfg.prefix} (${cfg.region})` };
  } catch (e) {
    return { ok: false, driver: 's3', detail: `${e.name}: ${e.message}` };
  }
}

/**
 * Streams an object (images, video, pdf) through the API so <img>/<video> tags work everywhere
 * (browser + Electron) with no CORS / expiring-URL problems. Supports HTTP Range for video seeking.
 * Returns { stream, status, headers }.
 */
export async function openObject(key, range) {
  if (cfg.driver === 's3') {
    await initS3();
    const out = await s3.send(
      new sdk.GetObjectCommand({ Bucket: cfg.bucket, Key: cfg.prefix + key, Range: range || undefined }),
    );
    const headers = { 'Content-Length': out.ContentLength, 'Accept-Ranges': 'bytes' };
    if (out.ContentRange) headers['Content-Range'] = out.ContentRange;
    return { stream: out.Body, status: range && out.ContentRange ? 206 : 200, headers };
  }
  const file = path.join(cfg.localDir, key);
  const stat = await fs.promises.stat(file); // throws if missing
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    return {
      stream: fs.createReadStream(file, { start, end }),
      status: 206,
      headers: { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes' },
    };
  }
  return { stream: fs.createReadStream(file), status: 200, headers: { 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' } };
}

/** Presigned download link for non-previewable files (docs, zips): keeps big downloads off the API server. */
export async function getDownloadUrl(key, filename, mime) {
  if (cfg.driver !== 's3') return null;
  await initS3();
  const cmd = new sdk.GetObjectCommand({
    Bucket: cfg.bucket,
    Key: cfg.prefix + key,
    ResponseContentType: mime,
    ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  });
  return presigner.getSignedUrl(s3, cmd, { expiresIn: cfg.urlTtl });
}

export async function deleteObject(key) {
  try {
    if (cfg.driver === 's3') {
      await initS3();
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: cfg.bucket, Key: cfg.prefix + key }));
    } else {
      await fs.promises.unlink(path.join(cfg.localDir, key));
    }
  } catch (e) {
    console.warn('[storage] delete failed', key, e.message);
  }
}
