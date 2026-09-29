// Store de sessão do express-session em SQLite (sobrevive a reinícios do painel).
import session from 'express-session';

export class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs = 12 * 3600 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.prune(), 15 * 60 * 1000);
    this.timer.unref();
  }

  prune() {
    try { this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch { /* banco fechado */ }
  }

  get(sid, cb) {
    try {
      const r = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.sess));
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttlMs;
      this.db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), exp);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }

  destroy(sid, cb) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb?.(null); } catch (e) { cb?.(e); }
  }
}
