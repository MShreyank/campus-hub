import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth, isMod } from '../auth.js';
import { wrap, HttpError, str } from '../util.js';

const router = Router();

const SELECT = (uid) => `
  SELECT c.*,
    (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS members,
    (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.removed = 0) AS post_count,
    ${uid ? `(SELECT role FROM community_members m WHERE m.community_id = c.id AND m.user_id = ${Number(uid)})` : 'NULL'} AS my_role
  FROM communities c`;

router.get('/', (req, res) => {
  const kind = req.query.kind;
  const rows = db
    .prepare(`${SELECT(req.user?.id)} ${kind ? 'WHERE c.kind = ?' : ''} ORDER BY members DESC, c.name`)
    .all(...(kind ? [kind] : []));
  res.json({ communities: rows.map((r) => ({ ...r, joined: !!r.my_role })) });
});

router.get(
  '/:name',
  wrap((req, res) => {
    const row = db.prepare(`${SELECT(req.user?.id)} WHERE c.name = ?`).get(req.params.name);
    if (!row) throw new HttpError(404, 'Community not found.');
    res.json({ community: { ...row, joined: !!row.my_role } });
  }),
);

router.post(
  '/',
  requireAuth,
  wrap((req, res) => {
    if (!isMod(req.user) && !config.allowStudentCommunities) throw new HttpError(403, 'Only teachers and admins can create communities.');
    const name = str(req.body.name, 30, { min: 3, name: 'Name' }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new HttpError(400, 'Name may only contain lowercase letters, numbers, hyphens and underscores.');
    const title = str(req.body.title || name, 80, { min: 1, name: 'Title' });
    const description = str(req.body.description || '', 500);
    const kind = ['general', 'course', 'department', 'club'].includes(req.body.kind) ? req.body.kind : 'general';
    if (db.prepare('SELECT 1 FROM communities WHERE name = ?').get(name)) throw new HttpError(409, 'A community with that name already exists.');
    const info = db
      .prepare('INSERT INTO communities (name, title, description, kind, created_by) VALUES (?,?,?,?,?)')
      .run(name, title, description, kind, req.user.id);
    db.prepare("INSERT INTO community_members (community_id, user_id, role) VALUES (?,?,'mod')").run(info.lastInsertRowid, req.user.id);
    const row = db.prepare(`${SELECT(req.user.id)} WHERE c.id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ community: { ...row, joined: true } });
  }),
);

router.patch(
  '/:name',
  requireAuth,
  wrap((req, res) => {
    const c = db.prepare('SELECT * FROM communities WHERE name = ?').get(req.params.name);
    if (!c) throw new HttpError(404, 'Community not found.');
    const mem = db.prepare('SELECT role FROM community_members WHERE community_id=? AND user_id=?').get(c.id, req.user.id);
    if (!(isMod(req.user) || mem?.role === 'mod')) throw new HttpError(403, 'Not allowed.');
    const title = str(req.body.title ?? c.title, 80, { min: 1, name: 'Title' });
    const description = str(req.body.description ?? c.description, 500);
    db.prepare('UPDATE communities SET title=?, description=? WHERE id=?').run(title, description, c.id);
    res.json({ ok: true });
  }),
);

router.post(
  '/:name/join',
  requireAuth,
  wrap((req, res) => {
    const c = db.prepare('SELECT id FROM communities WHERE name = ?').get(req.params.name);
    if (!c) throw new HttpError(404, 'Community not found.');
    db.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id) VALUES (?,?)').run(c.id, req.user.id);
    res.json({ joined: true });
  }),
);

router.post(
  '/:name/leave',
  requireAuth,
  wrap((req, res) => {
    const c = db.prepare('SELECT id FROM communities WHERE name = ?').get(req.params.name);
    if (!c) throw new HttpError(404, 'Community not found.');
    db.prepare('DELETE FROM community_members WHERE community_id=? AND user_id=?').run(c.id, req.user.id);
    res.json({ joined: false });
  }),
);

export default router;
