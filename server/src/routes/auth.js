import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db.js';
import { config } from '../config.js';
import { signToken, publicUser, requireAuth } from '../auth.js';
import { wrap, HttpError, str } from '../util.js';

const router = Router();
const limiter = (_req, _res, next) => next(); // demo: no rate limiting

// DEMO ONLY: passwords are stored and compared as plain text. Accounts created by older
// builds (bcrypt hashes starting with $2) still work.
const passwordOk = (given, stored) =>
  typeof stored === 'string' && (stored.startsWith('$2') ? bcrypt.compareSync(given, stored) : given === stored);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post(
  '/register',
  limiter,
  wrap(async (req, res) => {
    const email = str(req.body.email, 200, { min: 5, name: 'Email' }).toLowerCase();
    const username = str(req.body.username, 24, { min: 3, name: 'Username' });
    const display_name = str(req.body.display_name || username, 60, { min: 1, name: 'Display name' });
    const department = str(req.body.department || '', 80);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const wantsTeacher = req.body.role === 'teacher';

    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.');
    if (!/^[A-Za-z0-9_]+$/.test(username)) throw new HttpError(400, 'Username may only contain letters, numbers and underscores.');
    if (password.length < 3) throw new HttpError(400, 'Password must be at least 3 characters.');
    if (config.allowedEmailDomains.length) {
      const domain = email.split('@')[1];
      const ok = config.allowedEmailDomains.some((d) => domain === d || domain.endsWith('.' + d));
      if (!ok) throw new HttpError(400, `Please use your college email (${config.allowedEmailDomains.join(', ')}).`);
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with this email already exists.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');

    const isFirst = db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
    const makeAdmin = isFirst || config.adminEmails.includes(email);
    const role = makeAdmin ? 'admin' : wantsTeacher ? 'teacher' : 'student';
    const teacher_status = makeAdmin ? 'approved' : wantsTeacher ? 'pending' : 'none';

    const hash = password; // plain text (demo)
    const info = db
      .prepare(
        'INSERT INTO users (email, username, password_hash, display_name, role, teacher_status, department) VALUES (?,?,?,?,?,?,?)',
      )
      .run(email, username, hash, display_name, role, teacher_status, department);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

    // Everyone starts in the default communities.
    db.prepare(
      "INSERT OR IGNORE INTO community_members (community_id, user_id) SELECT id, ? FROM communities WHERE name IN ('announcements','general','study-help')",
    ).run(user.id);

    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  }),
);

router.post(
  '/login',
  limiter,
  wrap(async (req, res) => {
    const id = str(req.body.identifier || req.body.email, 200, { min: 1, name: 'Email or username' }).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(id, id);
    const ok = user && passwordOk(password, user.password_hash);
    if (!ok) throw new HttpError(401, 'Incorrect email/username or password.');
    if (user.banned) throw new HttpError(403, 'This account has been suspended.');
    res.json({ token: signToken(user), user: publicUser(user) });
  }),
);

router.get('/me', requireAuth, (req, res) => {
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(req.user.id).c;
  res.json({ user: publicUser(req.user), unread });
});

router.patch(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const display_name = str(req.body.display_name ?? req.user.display_name, 60, { min: 1, name: 'Display name' });
    const bio = str(req.body.bio ?? req.user.bio, 300);
    const department = str(req.body.department ?? req.user.department, 80);
    db.prepare('UPDATE users SET display_name=?, bio=?, department=? WHERE id=?').run(display_name, bio, department, req.user.id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)) });
  }),
);

router.post(
  '/password',
  requireAuth,
  limiter,
  wrap(async (req, res) => {
    const { current, next } = req.body;
    if (typeof next !== 'string' || next.length < 3) throw new HttpError(400, 'New password must be at least 3 characters.');
    if (!passwordOk(current || '', req.user.password_hash)) throw new HttpError(403, 'Current password is incorrect.');
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(next, req.user.id);
    res.json({ ok: true });
  }),
);

export default router;
