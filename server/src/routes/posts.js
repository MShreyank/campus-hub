import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireMod, isMod, publicUser } from '../auth.js';
import { wrap, HttpError, str, notify, paginate } from '../util.js';
import { deleteObject } from '../storage.js';

const router = Router();

export const POST_SELECT = (uid) => `
  SELECT p.id, p.title, p.body, p.type, p.pinned, p.locked, p.removed, p.score, p.comment_count, p.created_at,
    p.user_id,
    u.username AS author, u.display_name AS author_name, u.role AS author_role, u.teacher_status AS author_ts,
    c.name AS community, c.title AS community_title,
    ${uid ? `(SELECT value FROM votes v WHERE v.user_id = ${Number(uid)} AND v.target_type='post' AND v.target_id = p.id)` : 'NULL'} AS my_vote,
    (SELECT COUNT(*) FROM attachments a WHERE a.post_id = p.id) AS attachment_count
  FROM posts p
  JOIN users u ON u.id = p.user_id
  JOIN communities c ON c.id = p.community_id`;

export function shapePost(r, viewer) {
  const canSee = !r.removed || isMod(viewer) || viewer?.id === r.user_id;
  return {
    id: r.id,
    title: r.removed && !canSee ? '[removed]' : r.title,
    body: r.removed && !canSee ? '' : r.body,
    type: r.type,
    pinned: !!r.pinned,
    locked: !!r.locked,
    removed: !!r.removed,
    score: r.score,
    comment_count: r.comment_count,
    created_at: r.created_at,
    author: { username: r.author, display_name: r.author_name, role: r.author_role, verified_teacher: r.author_role === 'admin' || (r.author_role === 'teacher' && r.author_ts === 'approved') },
    community: { name: r.community, title: r.community_title },
    my_vote: r.my_vote ?? 0,
    attachment_count: r.attachment_count,
    can_edit: viewer ? viewer.id === r.user_id : false,
    can_moderate: isMod(viewer),
  };
}

/** Shapes a page of rows and attaches each post's media (images / video / files) in ONE extra query. */
export function shapePosts(rows, viewer) {
  const posts = rows.map((r) => shapePost(r, viewer));
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const media = db
    .prepare(
      `SELECT id, post_id, filename, mime, size FROM attachments WHERE post_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, rowid`,
    )
    .all(...ids);
  const by = new Map();
  for (const m of media) {
    if (!by.has(m.post_id)) by.set(m.post_id, []);
    by.get(m.post_id).push({ id: m.id, filename: m.filename, mime: m.mime, size: m.size, url: `/api/files/${m.id}` });
  }
  for (const p of posts) p.media = p.removed && !p.can_moderate && !p.can_edit ? [] : by.get(p.id) || [];
  return posts;
}

const ORDER = {
  hot: 'p.pinned DESC, (p.score + 2.0) / ((julianday(\'now\') - julianday(p.created_at)) * 24 + 2) DESC',
  new: 'p.pinned DESC, p.created_at DESC, p.id DESC',
  top: 'p.score DESC, p.created_at DESC',
  discussed: 'p.comment_count DESC, p.created_at DESC',
};

router.get(
  '/',
  wrap((req, res) => {
    const { limit, offset, page } = paginate(req);
    const sort = ORDER[req.query.sort] ? req.query.sort : 'hot';
    const where = ['p.removed = 0'];
    const params = [];
    if (req.query.community) {
      where.push('c.name = ?');
      params.push(req.query.community);
    }
    if (req.query.author) {
      where.push('u.username = ?');
      params.push(req.query.author);
    }
    if (req.query.type) {
      where.push('p.type = ?');
      params.push(req.query.type);
    }
    if (req.query.feed === 'home' && req.user) {
      where.push('p.community_id IN (SELECT community_id FROM community_members WHERE user_id = ?)');
      params.push(req.user.id);
    }
    if (req.query.sort === 'top' && req.query.t) {
      const days = { day: 1, week: 7, month: 30 }[req.query.t];
      if (days) where.push(`p.created_at >= datetime('now', '-${days} days')`);
    }
    const sql = `${POST_SELECT(req.user?.id)} WHERE ${where.join(' AND ')} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`;
    const rows = db.prepare(sql).all(...params, limit + 1, offset);
    res.json({ posts: shapePosts(rows.slice(0, limit), req.user), page, has_more: rows.length > limit });
  }),
);

router.get(
  '/:id',
  wrap((req, res) => {
    const r = db.prepare(`${POST_SELECT(req.user?.id)} WHERE p.id = ?`).get(req.params.id);
    if (!r) throw new HttpError(404, 'Post not found.');
    if (r.removed && !isMod(req.user) && req.user?.id !== r.user_id) throw new HttpError(404, 'This post has been removed.');
    const attachments = db
      .prepare('SELECT id, filename, mime, size FROM attachments WHERE post_id = ? ORDER BY created_at')
      .all(r.id)
      .map((a) => ({ ...a, url: `/api/files/${a.id}` }));
    res.json({ post: { ...shapePost(r, req.user), attachments } });
  }),
);

router.post(
  '/',
  requireAuth,
  wrap((req, res) => {
    const community = db.prepare('SELECT * FROM communities WHERE name = ?').get(String(req.body.community || ''));
    if (!community) throw new HttpError(400, 'Choose a community.');
    const title = str(req.body.title, 200, { min: 3, name: 'Title' });
    const body = str(req.body.body || '', 20000);
    const type = ['discussion', 'question', 'resource', 'announcement'].includes(req.body.type) ? req.body.type : 'discussion';
    if (type === 'announcement' && !isMod(req.user)) throw new HttpError(403, 'Only verified teachers and admins can post announcements.');

    const ids = Array.isArray(req.body.attachments) ? req.body.attachments.slice(0, 10).map(String) : [];
    const tx = db.transaction(() => {
      const info = db
        .prepare('INSERT INTO posts (community_id, user_id, title, body, type) VALUES (?,?,?,?,?)')
        .run(community.id, req.user.id, title, body, type);
      const postId = info.lastInsertRowid;
      const link = db.prepare('UPDATE attachments SET post_id = ? WHERE id = ? AND user_id = ? AND post_id IS NULL');
      for (const id of ids) link.run(postId, id, req.user.id);
      db.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id) VALUES (?,?)').run(community.id, req.user.id);
      return postId;
    });
    const postId = tx();

    if (type === 'announcement') {
      const members = db.prepare('SELECT user_id FROM community_members WHERE community_id = ?').all(community.id);
      for (const m of members)
        notify({ userId: m.user_id, type: 'announcement', actorId: req.user.id, postId, message: `New announcement in ${community.title}: ${title}` });
    }
    res.status(201).json({ id: postId });
  }),
);

router.patch(
  '/:id',
  requireAuth,
  wrap((req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!p) throw new HttpError(404, 'Post not found.');
    if (p.user_id !== req.user.id) throw new HttpError(403, 'You can only edit your own posts.');
    const body = str(req.body.body ?? p.body, 20000);
    const title = str(req.body.title ?? p.title, 200, { min: 3, name: 'Title' });
    db.prepare('UPDATE posts SET body = ?, title = ? WHERE id = ?').run(body, title, p.id);
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!p) throw new HttpError(404, 'Post not found.');
    const own = p.user_id === req.user.id;
    if (!own && !isMod(req.user)) throw new HttpError(403, 'Not allowed.');
    if (own) {
      // Author deletion is permanent, including files in cloud storage.
      const files = db.prepare('SELECT storage_key FROM attachments WHERE post_id = ?').all(p.id);
      db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
      await Promise.all(files.map((f) => deleteObject(f.storage_key)));
    } else {
      db.prepare('UPDATE posts SET removed = 1, pinned = 0 WHERE id = ?').run(p.id);
      notify({ userId: p.user_id, type: 'removed', actorId: req.user.id, postId: p.id, message: `A moderator removed your post "${p.title}".` });
    }
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/restore',
  requireAuth,
  requireMod,
  wrap((req, res) => {
    db.prepare('UPDATE posts SET removed = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  }),
);

const toggle = (field) =>
  wrap((req, res) => {
    const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!p) throw new HttpError(404, 'Post not found.');
    const val = p[field] ? 0 : 1;
    db.prepare(`UPDATE posts SET ${field} = ? WHERE id = ?`).run(val, p.id);
    res.json({ [field]: !!val });
  });
router.post('/:id/pin', requireAuth, requireMod, toggle('pinned'));
router.post('/:id/lock', requireAuth, requireMod, toggle('locked'));

// ---- Comments -------------------------------------------------------------
router.get(
  '/:id/comments',
  wrap((req, res) => {
    const uid = req.user?.id;
    const rows = db
      .prepare(
        `SELECT cm.*, u.username, u.display_name, u.role, u.teacher_status,
          ${uid ? `(SELECT value FROM votes v WHERE v.user_id=${Number(uid)} AND v.target_type='comment' AND v.target_id=cm.id)` : 'NULL'} AS my_vote
         FROM comments cm JOIN users u ON u.id = cm.user_id
         WHERE cm.post_id = ? ORDER BY cm.created_at, cm.id`,
      )
      .all(req.params.id);
    const mod = isMod(req.user);
    res.json({
      comments: rows.map((r) => {
        const hidden = r.removed && !mod;
        return {
          id: r.id,
          parent_id: r.parent_id,
          body: hidden ? '[removed]' : r.body,
          removed: !!r.removed,
          endorsed: !!r.endorsed,
          score: r.score,
          created_at: r.created_at,
          author: { username: r.username, display_name: r.display_name, role: r.role, verified_teacher: r.role === 'admin' || (r.role === 'teacher' && r.teacher_status === 'approved') },
          my_vote: r.my_vote ?? 0,
          can_delete: !!uid && (uid === r.user_id || mod),
        };
      }),
    });
  }),
);

router.post(
  '/:id/comments',
  requireAuth,
  wrap((req, res) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ? AND removed = 0').get(req.params.id);
    if (!post) throw new HttpError(404, 'Post not found.');
    if (post.locked && !isMod(req.user)) throw new HttpError(403, 'This thread is locked.');
    const body = str(req.body.body, 10000, { min: 1, name: 'Comment' });
    let parent = null;
    if (req.body.parent_id) {
      parent = db.prepare('SELECT * FROM comments WHERE id = ? AND post_id = ?').get(req.body.parent_id, post.id);
      if (!parent) throw new HttpError(400, 'Parent comment not found.');
    }
    const info = db.prepare('INSERT INTO comments (post_id, parent_id, user_id, body) VALUES (?,?,?,?)').run(post.id, parent?.id ?? null, req.user.id, body);
    db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(post.id);
    const cid = info.lastInsertRowid;
    const who = req.user.display_name;
    if (parent) notify({ userId: parent.user_id, type: 'reply', actorId: req.user.id, postId: post.id, commentId: cid, message: `${who} replied to your comment.` });
    if (!parent || parent.user_id !== post.user_id)
      notify({ userId: post.user_id, type: 'comment', actorId: req.user.id, postId: post.id, commentId: cid, message: `${who} commented on "${post.title}".` });
    res.status(201).json({ id: cid });
  }),
);

export default router;
export { publicUser };
