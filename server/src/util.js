import { db } from './db.js';

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const str = (v, max, { min = 0, name = 'Field' } = {}) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < min) throw new HttpError(400, `${name} must be at least ${min} character${min === 1 ? '' : 's'}.`);
  if (s.length > max) throw new HttpError(400, `${name} must be at most ${max} characters.`);
  return s;
};

export function notify({ userId, type, actorId, postId = null, commentId = null, message }) {
  if (!userId || userId === actorId) return;
  db.prepare(
    'INSERT INTO notifications (user_id, type, actor_id, post_id, comment_id, message) VALUES (?,?,?,?,?,?)',
  ).run(userId, type, actorId ?? null, postId, commentId, message);
}

export const paginate = (req, def = 20, max = 50) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || def, 1), max);
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  return { limit, offset: (page - 1) * limit, page };
};
