import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin, publicUser } from '../auth.js';
import { wrap, HttpError, notify } from '../util.js';
import { putObject, openObject, getDownloadUrl, deleteObject } from '../storage.js';
import { POST_SELECT, shapePosts } from './posts.js';

const router = Router();

// ---- File uploads (cloud storage) ------------------------------------------------
const ALLOWED = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED[ext]) return cb(new HttpError(400, `File type ${ext || '(none)'} is not allowed.`));
    cb(null, true);
  },
});

router.post(
  '/uploads',
  requireAuth,
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file received.');
    const recent = db.prepare("SELECT COUNT(*) AS c FROM attachments WHERE user_id = ? AND created_at > datetime('now','-1 hour')").get(req.user.id).c;
    if (recent >= 200) throw new HttpError(429, 'Upload limit reached. Try again later.');

    const ext = path.extname(req.file.originalname).toLowerCase();
    const id = crypto.randomUUID();
    const key = `${new Date().getFullYear()}-${id}${ext}`;
    const mime = ALLOWED[ext]; // never trust the client-supplied mimetype
    await putObject(key, req.file.buffer, mime);
    const filename = path.basename(req.file.originalname).slice(0, 150);
    db.prepare('INSERT INTO attachments (id, user_id, storage_key, filename, mime, size) VALUES (?,?,?,?,?,?)').run(
      id, req.user.id, key, filename, mime, req.file.size,
    );
    res.status(201).json({ id, filename, mime, size: req.file.size, url: `/api/files/${id}` });
  }),
);

// Discard an upload that was never attached to a post (user removed it from the composer).
router.delete(
  '/uploads/:id',
  requireAuth,
  wrap(async (req, res) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ? AND post_id IS NULL').get(req.params.id, req.user.id);
    if (a) {
      db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
      await deleteObject(a.storage_key);
    }
    res.json({ ok: true });
  }),
);

// Public by unguessable UUID so <img>/<video> tags work. Images, video, audio and PDFs are streamed
// through the API (cached by the browser; Range supported for video seeking), whether they live on
// local disk or in the private S3 bucket. Other files redirect to a short-lived presigned download URL.
router.get(
  '/files/:id',
  wrap(async (req, res) => {
    const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
    if (!a) throw new HttpError(404, 'File not found.');
    const streamable = /^(image|video|audio)\//.test(a.mime) || a.mime === 'application/pdf';
    if (!streamable) {
      const url = await getDownloadUrl(a.storage_key, a.filename, a.mime);
      if (url) return res.redirect(302, url);
    }
    let obj;
    try {
      obj = await openObject(a.storage_key, req.headers.range);
    } catch (e) {
      if (e.code === 'ENOENT' || e.name === 'NoSuchKey') throw new HttpError(404, 'File missing.');
      throw e;
    }
    const inline = streamable;
    res.status(obj.status);
    for (const [k, v] of Object.entries(obj.headers)) res.set(k, String(v));
    res.set('Content-Type', a.mime);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    obj.stream.on('error', () => res.destroy());
    obj.stream.pipe(res);
  }),
);

// ---- Search -------------------------------------------------------------------------
router.get(
  '/search',
  wrap((req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ posts: [], communities: [], users: [] });
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const posts = db
      .prepare(`${POST_SELECT(req.user?.id)} WHERE p.removed = 0 AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\') ORDER BY p.score DESC, p.created_at DESC LIMIT 40`)
      .all(like, like);
    const shaped = shapePosts(posts, req.user);
    const communities = db
      .prepare("SELECT name, title, description, kind FROM communities WHERE name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' LIMIT 15")
      .all(like, like, like);
    const users = db
      .prepare("SELECT * FROM users WHERE banned = 0 AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') LIMIT 15")
      .all(like, like)
      .map(publicUser);
    res.json({ posts: shaped, communities, users });
  }),
);

// ---- Profiles ----------------------------------------------------------------------------
router.get(
  '/users/:username',
  wrap((req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
    if (!u || u.banned) throw new HttpError(404, 'User not found.');
    const stats = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM posts WHERE user_id=? AND removed=0) AS posts,
                (SELECT COUNT(*) FROM comments WHERE user_id=? AND removed=0) AS comments,
                (SELECT COALESCE(SUM(score),0) FROM posts WHERE user_id=? AND removed=0) +
                (SELECT COALESCE(SUM(score),0) FROM comments WHERE user_id=? AND removed=0) AS karma`,
      )
      .get(u.id, u.id, u.id, u.id);
    res.json({ user: publicUser(u), stats });
  }),
);

// ---- Admin -----------------------------------------------------------------------------------
router.get(
  '/admin/users',
  requireAuth,
  requireAdmin,
  wrap((req, res) => {
    const q = String(req.query.q || '').trim();
    const filter = req.query.filter;
    const where = [];
    const params = [];
    if (q) {
      where.push('(username LIKE ? OR email LIKE ? OR display_name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (filter === 'pending') where.push("teacher_status = 'pending'");
    if (filter === 'banned') where.push('banned = 1');
    const rows = db
      .prepare(`SELECT * FROM users ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (teacher_status='pending') DESC, created_at DESC LIMIT 200`)
      .all(...params);
    res.json({ users: rows.map((u) => ({ ...publicUser(u), email: u.email, banned: !!u.banned })) });
  }),
);

router.patch(
  '/admin/users/:id',
  requireAuth,
  requireAdmin,
  wrap((req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw new HttpError(404, 'User not found.');
    if (u.id === req.user.id && (req.body.banned || (req.body.role && req.body.role !== 'admin')))
      throw new HttpError(400, "You can't demote or ban yourself.");
    let { role, teacher_status, banned } = { role: u.role, teacher_status: u.teacher_status, banned: u.banned };
    if (['student', 'teacher', 'admin'].includes(req.body.role)) role = req.body.role;
    if (['none', 'pending', 'approved'].includes(req.body.teacher_status)) teacher_status = req.body.teacher_status;
    if (typeof req.body.banned === 'boolean') banned = req.body.banned ? 1 : 0;
    if (role === 'teacher' && req.body.teacher_status === undefined && u.role !== 'teacher') teacher_status = 'approved';
    if (role === 'student') teacher_status = 'none';
    db.prepare('UPDATE users SET role=?, teacher_status=?, banned=? WHERE id=?').run(role, teacher_status, banned, u.id);
    if (teacher_status === 'approved' && u.teacher_status !== 'approved')
      notify({ userId: u.id, type: 'verified', actorId: req.user.id, message: 'Your teacher account has been verified. You can now moderate and post announcements.' });
    res.json({ ok: true });
  }),
);

router.get(
  '/admin/stats',
  requireAuth,
  requireAdmin,
  (_req, res) => {
    const c = (sql) => db.prepare(sql).get().c;
    res.json({
      users: c('SELECT COUNT(*) AS c FROM users'),
      pending_teachers: c("SELECT COUNT(*) AS c FROM users WHERE teacher_status='pending'"),
      communities: c('SELECT COUNT(*) AS c FROM communities'),
      posts: c('SELECT COUNT(*) AS c FROM posts WHERE removed=0'),
      comments: c('SELECT COUNT(*) AS c FROM comments WHERE removed=0'),
      open_reports: c("SELECT COUNT(*) AS c FROM reports WHERE status='open'"),
      files: c('SELECT COUNT(*) AS c FROM attachments'),
      storage_bytes: c('SELECT COALESCE(SUM(size),0) AS c FROM attachments'),
      storage_driver: storageDriver,
    });
  },
);

export default router;
