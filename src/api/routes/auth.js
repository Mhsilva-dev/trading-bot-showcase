import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { validate, newCsrfToken, sameOrigin } from '../../server/security.js';

const LoginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

// Hash fixo para comparar mesmo quando o usuário não existe (tempo constante).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

export function authRoutes({ repo, log }) {
  const r = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
  });

  r.post('/login', loginLimiter, sameOrigin, async (req, res, next) => {
    try {
      const { username, password } = validate(LoginSchema, req.body);
      const user = repo.getUser(username);
      // Usuário travado: recusa sem nem comparar a senha.
      if (user && user.locked_until > Date.now()) {
        const min = Math.ceil((user.locked_until - Date.now()) / 60_000);
        log.warn('SECURITY', 'LOGIN_LOCKED', `Tentativa de login em "${username}" bloqueado`, { ip: req.ip });
        return res.status(423).json({ error: `Usuário bloqueado por excesso de tentativas. Tente em ${min} min.` });
      }
      const ok = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
      if (!user || !ok) {
        const f = user ? repo.registerLoginFailure(username) : null;
        if (f && f.lockedUntil > Date.now()) {
          log.critical('SECURITY', 'USER_LOCKED', `Usuário "${username}" bloqueado por 1h após 5 senhas erradas`, { ip: req.ip });
        } else {
          log.warn('SECURITY', 'LOGIN_FAILED', `Falha de login para "${username}"`, { ip: req.ip });
        }
        return res.status(401).json({ error: 'Usuário ou senha inválidos' });
      }
      repo.resetLoginFailures(username);
      // Nova sessão a cada login (evita fixação de sessão).
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.user = { id: user.id, username: user.username };
        req.session.csrf = newCsrfToken();
        log.info('SECURITY', 'LOGIN', `Login de "${username}"`, { ip: req.ip });
        res.json({ user: req.session.user, csrfToken: req.session.csrf });
      });
    } catch (e) { next(e); }
  });

  r.post('/logout', (req, res) => {
    const u = req.session?.user?.username;
    req.session?.destroy(() => {
      res.clearCookie('tb.sid');
      if (u) log.info('SECURITY', 'LOGOUT', `Logout de "${u}"`);
      res.json({ ok: true });
    });
  });

  r.get('/me', (req, res) => {
    if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
    if (!req.session.csrf) req.session.csrf = newCsrfToken();
    res.json({ user: req.session.user, csrfToken: req.session.csrf });
  });

  return r;
}
