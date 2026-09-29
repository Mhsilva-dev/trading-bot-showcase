import crypto from 'node:crypto';

// Exige usuário autenticado.
export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Não autenticado' });
}

// CSRF: toda requisição que altera estado precisa do header X-CSRF-Token
// igual ao token da sessão (o cookie é SameSite=strict como segunda barreira).
export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token');
  const expected = req.session?.csrf;
  if (!token || !expected || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Token CSRF inválido' });
  }
  next();
}

// Login: se o navegador mandar Origin, ele tem que ser o próprio host.
export function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get('host')) return next();
  } catch { /* cai no 403 */ }
  res.status(403).json({ error: 'Origem não permitida' });
}

export function newCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Erro de validação padronizado (zod).
export function validate(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`).join('; ');
    const err = new Error(msg);
    err.status = 400;
    throw err;
  }
  return r.data;
}

// Protege CSV contra injeção de fórmula no Excel/Sheets.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.label ?? c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => csvCell(typeof c.get === 'function' ? c.get(r) : r[c.key])).join(','));
  return [head, ...body].join('\n');
}
