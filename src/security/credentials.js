// Acesso às credenciais de corretora cadastradas no painel.
// getBrokerCredential() é SOMENTE para uso interno do backend (ponte MT5);
// nenhuma rota da API devolve a senha.
import { decrypt, encrypt, maskLogin, parseKey } from './vault.js';

export const PROVIDERS = {
  xp_mt5: { label: 'XP Investimentos — MetaTrader 5', broker: 'XP', platform: 'MT5' },
};

export function storeBrokerCredential(repo, keyHex, { provider, environment, server, login, password, by }) {
  const key = parseKey(keyHex);
  repo.saveCredential({ provider, environment, server, login, secret_enc: encrypt(key, password, provider), updated_by: by });
}

export function getBrokerCredential(repo, keyHex, provider) {
  const row = repo.getCredential(provider);
  if (!row) return null;
  return { environment: row.environment, server: row.server, login: row.login, password: decrypt(parseKey(keyHex), row.secret_enc, provider) };
}

// Visão segura para o painel.
export function publicCredential(repo, provider) {
  const row = repo.getCredential(provider);
  return {
    provider,
    ...PROVIDERS[provider],
    configured: !!row,
    environment: row?.environment ?? null,
    server: row?.server ?? null,
    login: row ? maskLogin(row.login) : null,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    bridge: {
      status: row?.bridge_status || (row ? 'WAITING' : 'NOT_CONFIGURED'),
      message: row?.bridge_message || (row ? 'Aguardando a ponte MT5 conectar (instalação do MetaTrader 5 no servidor pendente)' : null),
      seenAt: row?.bridge_seen_at ?? null,
    },
  };
}
