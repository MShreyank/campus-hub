import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '7d' });

export const isMod = (u) => !!u && (u.role === 'admin' || (u.role === 'teacher' && u.teacher_status === 'approved'));
export const isAdmin = (u) => !!u && u.role === 'admin';

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    teacher_status: u.teacher_status,
    verified_teacher: u.role === 'teacher' && u.teacher_status === 'approved',
    department: u.department,
    bio: u.bio,
    created_at: u.created_at,
  };
}

/** Attaches req.user if a valid bearer token is present. Never rejects. */
export function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    try {
      const { sub } = jwt.verify(token, config.jwtSecret);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
      if (u && !u.banned) req.user = u;
    } catch {
      /* invalid token -> anonymous */
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

export function requireMod(req, res, next) {
  if (!isMod(req.user)) return res.status(403).json({ error: 'Moderator (verified teacher/admin) access required.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin access required.' });
  next();
}
