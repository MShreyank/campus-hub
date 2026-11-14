import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireMod, isMod } from '../auth.js';
import { wrap, HttpError, notify } from '../util.js';

const router = Router();

// ---- Votes ----------------------------------------------------------------
router.post(
  '/votes',
  requireAuth,
  wrap((req, res) => {
    const type = req.body.type;
    const id = Number(req.body.id);
    const value = Number(req.body.value);
    if (!['post', 'comment'].includes(type) || !Number.isInteger(id)) throw new HttpError(400, 'Invalid vote.');
    if (![-1, 0, 1].includes(value)) throw new HttpError(400, 'Invalid vote value.');
    const table = type === 'post' ? 'posts' : 'comments';
    const target = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!target) throw new HttpError(404, 'Not found.');
    if (target.user_id === req.user.id) throw new HttpError(400, "You can't vote on your own content.");

    const tx = db.transaction(() => {
      if (value === 0) db.prepare('DELETE FROM votes WHERE user_id=? AND target_type=? AND target_id=?').run(req.user.id, type, id);
      else
        db.prepare(
          `INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?,?,?,?)
           ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET value = excluded.value`,
        ).run(req.user.id, type, id, value);
      const score = db.prepare('SELECT COALESCE(SUM(value),0) AS s FROM votes WHERE target_type=? AND target_id=?').get(type, id).s;
      db.prepare(`UPDATE ${table} SET score = ? WHERE id = ?`).run(score, id);
      return score;
    });
    res.json({ score: tx(), my_vote: value });
  }),
);

// ---- Comment actions ---------------------------------------------------------
router.delete(
  '/comments/:id',
  requireAuth,
  wrap((req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
    if (!c) throw new HttpError(404, 'Comment not found.');
    const own = c.user_id === req.user.id;
    if (!own && !isMod(req.user)) throw new HttpError(403, 'Not allowed.');
    db.prepare('UPDATE comments SET removed = 1, endorsed = 0 WHERE id = ?').run(c.id);
    if (!own) notify({ userId: c.user_id, type: 'removed', actorId: req.user.id, postId: c.post_id, commentId: c.id, message: 'A moderator removed your comment.' });
    res.json({ ok: true });
  }),
);

router.post(
  '/comments/:id/restore',
  requireAuth,
  requireMod,
  wrap((req, res) => {
    db.prepare('UPDATE comments SET removed = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  }),
);

// Teacher-endorsed answer.
router.post(
  '/comments/:id/endorse',
  requireAuth,
  requireMod,
  wrap((req, res) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ? AND removed = 0').get(req.params.id);
    if (!c) throw new HttpError(404, 'Comment not found.');
    const val = c.endorsed ? 0 : 1;
    db.prepare('UPDATE comments SET endorsed = ? WHERE id = ?').run(val, c.id);
    if (val) notify({ userId: c.user_id, type: 'endorsed', actorId: req.user.id, postId: c.post_id, commentId: c.id, message: `${req.user.display_name} endorsed your answer.` });
    res.json({ endorsed: !!val });
  }),
);

// ---- Notifications --------------------------------------------------------------
router.get(
  '/notifications',
  requireAuth,
  wrap((req, res) => {
    const rows = db
      .prepare(
        `SELECT n.id, n.type, n.post_id, n.comment_id, n.message, n.read, n.created_at, u.username AS actor
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
         WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 100`,
      )
      .all(req.user.id);
    res.json({ notifications: rows.map((n) => ({ ...n, read: !!n.read })) });
  }),
);
router.post('/notifications/read', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  if (ids?.length) {
    const stmt = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?');
    for (const id of ids) stmt.run(id, req.user.id);
  } else db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---- Reports -------------------------------------------------------------------
router.post(
  '/reports',
  requireAuth,
  wrap((req, res) => {
    const type = req.body.type;
    const id = Number(req.body.id);
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    if (!['post', 'comment'].includes(type) || !Number.isInteger(id)) throw new HttpError(400, 'Invalid report.');
    if (reason.length < 3) throw new HttpError(400, 'Please describe the problem.');
    const exists = db.prepare(`SELECT 1 FROM ${type === 'post' ? 'posts' : 'comments'} WHERE id = ?`).get(id);
    if (!exists) throw new HttpError(404, 'Not found.');
    db.prepare(
      `INSERT INTO reports (reporter_id, target_type, target_id, reason) VALUES (?,?,?,?)
       ON CONFLICT(reporter_id, target_type, target_id) DO UPDATE SET reason = excluded.reason, status = 'open'`,
    ).run(req.user.id, type, id, reason);
    res.status(201).json({ ok: true });
  }),
);

router.get(
  '/reports',
  requireAuth,
  requireMod,
  wrap((req, res) => {
    const status = ['open', 'dismissed', 'actioned'].includes(req.query.status) ? req.query.status : 'open';
    const rows = db
      .prepare(
        `SELECT r.*, ru.username AS reporter FROM reports r JOIN users ru ON ru.id = r.reporter_id
         WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`,
      )
      .all(status);
    const out = rows.map((r) => {
      let target = null;
      if (r.target_type === 'post') {
        target = db.prepare('SELECT p.id, p.title AS text, p.removed, u.username AS author, p.id AS post_id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?').get(r.target_id);
      } else {
        target = db.prepare('SELECT c.id, c.body AS text, c.removed, u.username AS author, c.post_id FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?').get(r.target_id);
      }
      return { id: r.id, type: r.target_type, target_id: r.target_id, reason: r.reason, status: r.status, reporter: r.reporter, created_at: r.created_at, target };
    });
    res.json({ reports: out });
  }),
);

router.post(
  '/reports/:id/resolve',
  requireAuth,
  requireMod,
  wrap((req, res) => {
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!r) throw new HttpError(404, 'Report not found.');
    const action = req.body.action === 'remove' ? 'remove' : 'dismiss';
    if (action === 'remove') {
      const table = r.target_type === 'post' ? 'posts' : 'comments';
      const t = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(r.target_id);
      if (t) {
        db.prepare(`UPDATE ${table} SET removed = 1 WHERE id = ?`).run(t.id);
        notify({ userId: t.user_id, type: 'removed', actorId: req.user.id, postId: r.target_type === 'post' ? t.id : t.post_id, message: `A moderator removed your ${r.target_type} after a report.` });
      }
    }
    // resolve all reports on the same target
    db.prepare('UPDATE reports SET status = ?, resolved_by = ? WHERE target_type = ? AND target_id = ?').run(
      action === 'remove' ? 'actioned' : 'dismissed',
      req.user.id,
      r.target_type,
      r.target_id,
    );
    res.json({ ok: true });
  }),
);

export default router;
