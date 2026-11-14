import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env from (first wins): CAMPUS_ENV_FILE, server/.env, <project root>/.env, ./.env
for (const f of [process.env.CAMPUS_ENV_FILE, path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env'), path.resolve('.env')]) {
  if (f && fs.existsSync(f)) dotenv.config({ path: f });
}

const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const isProd = process.env.NODE_ENV === 'production';
let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  // Demo build: never refuse to start because of a missing secret.
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set - using a random one (sessions reset on restart).');
}

export const config = {
  isProd,
  port: Number(process.env.PORT || 4000),
  jwtSecret,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'campus.db'),
  // Demo: any email is allowed unless you set e.g. "college.edu,cs.college.edu".
  allowedEmailDomains: list(process.env.ALLOWED_EMAIL_DOMAINS),
  adminEmails: list(process.env.ADMIN_EMAILS),
  allowStudentCommunities: (process.env.ALLOW_STUDENT_COMMUNITIES || 'true') === 'true',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 25),
  storage: {
    driver: process.env.S3_BUCKET ? 's3' : 'local',
    bucket: process.env.S3_BUCKET,
    region: process.env.AWS_REGION || 'ap-south-1',
    endpoint: process.env.S3_ENDPOINT || undefined, // for MinIO / R2 / localstack
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    prefix: process.env.S3_PREFIX || 'uploads/',
    localDir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    urlTtl: Number(process.env.S3_URL_TTL_SECONDS || 300),
  },
};
