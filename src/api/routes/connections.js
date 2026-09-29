import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../../server/security.js';
import { PROVIDERS, publicCredential, storeBrokerCredential } from '../../security/credentials.js';
import { maskLogin } from '../../security/vault.js';

const Provider = z.enum(Object.keys(PROVIDERS));

// CPF válido (dígitos verificadores). O login do MT5 é outro número —
// CPF aqui significa que a pessoa está usando o login do app da XP.
export function looksLikeCpf(v) {
  const d = String(v).replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Number(d[i]) * (n + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

const SaveSchema = z.object({
  environment: z.enum(['demo', 'real']),
  server: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._ -]{2,63}(:\d{2,5})?$/, 'servidor inválido (ex.: demo.mt5.xpi.com.br:443)'),
  login: z.string().trim().regex(/^\d{4,20}$/, 'login deve ser o número da conta MT5'),
  password: z.string().min(4).max(128),
  currentPassword: z.string().min(1).max(256),
  confirmReal: z.boolean().optional(),
}).strict();

const DeleteSchema = z.object({ currentPassword: z.string().min(1).max(256) }).strict();

export function connectionRoutes({ repo, config, log }) {
  const r = Router();
  // Poucas tentativas: a rota exige a senha do painel.
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde 15 minutos.' } });

  const checkPanelPassword = async (req, password) => {
    const user = repo.getUser(req.session.user.username);
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      log.warn('SECURITY', 'REAUTH_FAILED', `Senha do painel incorreta ao alterar credenciais (${req.session.user.username})`, { ip: req.ip });
      const e = new Error('Senha do painel incorreta');
      e.status = 403;
      throw e;
    }
  };

  r.get('/connections', (req, res) => {
    res.json({ rows: Object.keys(PROVIDERS).map((p) => publicCredential(repo, p)), vaultReady: !!config.credentialsKey });
  });

  r.put('/connections/:provider', limiter, async (req, res, next) => {
    try {
      const provider = validate(Provider, req.params.provider);
      const body = validate(SaveSchema, req.body);
      if (looksLikeCpf(body.login)) {
        log.warn('SECURITY', 'CPF_REJECTED', 'Tentativa de cadastrar CPF como login do MT5 bloqueada');
        return res.status(400).json({ error: 'Isso parece um CPF. Use o LOGIN DO METATRADER 5 (número da conta MT5 Simulado), nunca o CPF e a senha do app da XP.' });
      }
      if (!config.credentialsKey) return res.status(503).json({ error: 'Cofre não configurado no servidor (CREDENTIALS_KEY)' });
      if (body.environment === 'real' && body.confirmReal !== true) return res.status(400).json({ error: 'Confirme que deseja cadastrar uma conta REAL', needsConfirm: true });
      await checkPanelPassword(req, body.currentPassword);
      storeBrokerCredential(repo, config.credentialsKey, { provider, environment: body.environment, server: body.server, login: body.login, password: body.password, by: req.session.user.username });
      log.warn('SECURITY', 'BROKER_CREDENTIAL_SAVED', `Credenciais ${PROVIDERS[provider].label} (${body.environment}) salvas por ${req.session.user.username}: servidor ${body.server}, login ${maskLogin(body.login)}`);
      res.json(publicCredential(repo, provider));
    } catch (e) { next(e); }
  });

  r.delete('/connections/:provider', limiter, async (req, res, next) => {
    try {
      const provider = validate(Provider, req.params.provider);
      const body = validate(DeleteSchema, req.body);
      await checkPanelPassword(req, body.currentPassword);
      const n = repo.deleteCredential(provider);
      log.warn('SECURITY', 'BROKER_CREDENTIAL_DELETED', `Credenciais ${PROVIDERS[provider].label} removidas por ${req.session.user.username}`);
      res.json({ ok: true, removed: n > 0 });
    } catch (e) { next(e); }
  });

  return r;
}
