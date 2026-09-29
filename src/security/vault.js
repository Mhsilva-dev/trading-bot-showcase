// Cofre de credenciais de corretora: AES-256-GCM com chave própria
// (CREDENTIALS_KEY no .env, 32 bytes em hex). O banco guarda só o texto
// cifrado; sem a chave do .env ele é inútil. GCM detecta adulteração.
import crypto from 'node:crypto';

export class VaultError extends Error {}

export function parseKey(hex) {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new VaultError('CREDENTIALS_KEY ausente ou inválida (64 caracteres hex — gere com: openssl rand -hex 32)');
  return Buffer.from(hex, 'hex');
}

// Formato: v1:<iv b64>:<tag b64>:<dados b64>. `aad` amarra o segredo ao seu dono
// (ex.: "xp_mt5"), impedindo copiar o cifrado de um registro para outro.
export function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(key, payload, aad) {
  const [v, iv, tag, data] = String(payload).split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new VaultError('Formato de credencial cifrada inválido');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    if (aad) d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new VaultError('Não foi possível decifrar a credencial (chave errada ou dado adulterado)');
  }
}

export function maskLogin(login) {
  const s = String(login || '');
  return s.length <= 3 ? '***' : `${'*'.repeat(Math.min(6, s.length - 3))}${s.slice(-3)}`;
}
