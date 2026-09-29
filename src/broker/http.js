import { BrokerError, ErrorKind, asBrokerError } from './errors.js';
import { sleep } from '../lib/util.js';

// Circuit breaker: após N falhas seguidas, abre por cooldownMs e recusa
// chamadas imediatamente. Depois do cooldown deixa UMA chamada passar
// (half-open); se ela funcionar, fecha.
export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 60_000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = null;
  }

  get state() {
    if (this.openedAt === null) return 'CLOSED';
    return this.now() - this.openedAt >= this.cooldownMs ? 'HALF_OPEN' : 'OPEN';
  }

  check() {
    if (this.state === 'OPEN') {
      throw new BrokerError(ErrorKind.CIRCUIT_OPEN, 'Circuit breaker aberto: corretora instável, aguardando cooldown');
    }
  }

  success() { this.failures = 0; this.openedAt = null; }

  failure() {
    this.failures += 1;
    if (this.failures >= this.threshold || this.state === 'HALF_OPEN') this.openedAt = this.now();
  }
}

// Respeita o limite por endpoint da corretora (ex.: 1 req/s em /candles).
export class RateLimiter {
  constructor() { this.last = new Map(); }

  async wait(key, minIntervalMs) {
    if (!minIntervalMs) return;
    const prev = this.last.get(key) || 0;
    const delta = Date.now() - prev;
    if (delta < minIntervalMs) await sleep(minIntervalMs - delta);
    this.last.set(key, Date.now());
  }
}

function classifyStatus(status, body) {
  const msg = typeof body === 'object' && body ? (body.message || body.error || JSON.stringify(body)) : String(body || '');
  if (status === 401 || status === 403) return new BrokerError(ErrorKind.AUTH, `Erro de autenticação (${status}): ${msg}`, { status });
  if (status === 429) return new BrokerError(ErrorKind.RATE_LIMIT, 'Rate limit da corretora atingido', { status });
  if (status === 404) return new BrokerError(ErrorKind.NOT_FOUND, `Não encontrado: ${msg}`, { status });
  if (status >= 500) return new BrokerError(ErrorKind.SERVER, `Erro no servidor da corretora (${status})`, { status });
  if (/insufficient|saldo|balance/i.test(msg)) return new BrokerError(ErrorKind.INSUFFICIENT_FUNDS, `Saldo insuficiente: ${msg}`, { status, code: body?.code });
  return new BrokerError(ErrorKind.REJECTED, `Requisição rejeitada (${status}): ${msg}`, { status, code: body?.code });
}

// Cliente HTTP com timeout, retry limitado + backoff exponencial (só quando
// `retry` > 0 e o erro é transitório) e circuit breaker compartilhado.
export class HttpClient {
  constructor({ baseUrl, timeoutMs = 10_000, breaker = new CircuitBreaker(), limiter = new RateLimiter(), fetchImpl = fetch, baseDelayMs = 500 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.breaker = breaker;
    this.limiter = limiter;
    this.fetch = fetchImpl;
    this.baseDelayMs = baseDelayMs;
  }

  async request(method, path, { query, body, form, headers = {}, retry = 0, rateKey, minIntervalMs } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        this.breaker.check();
        await this.limiter.wait(rateKey || path, minIntervalMs);
        const result = await this.once(method, path, { query, body, form, headers });
        this.breaker.success();
        return result;
      } catch (e) {
        const err = asBrokerError(e);
        // Erros "de negócio" (rejeição, saldo, 404) não indicam instabilidade.
        if (err.retryable || err.kind === ErrorKind.INVALID_RESPONSE) this.breaker.failure();
        if (err.kind === ErrorKind.CIRCUIT_OPEN || !err.retryable || attempt >= retry) throw err;
        const delay = err.retryAfterMs ?? this.baseDelayMs * 2 ** attempt;
        attempt += 1;
        await sleep(Math.min(delay, 30_000));
      }
    }
  }

  async once(method, path, { query, body, form, headers }) {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const init = { method, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(this.timeoutMs) };
    if (form) {
      init.body = new URLSearchParams(form).toString();
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const res = await this.fetch(url, init);
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch {
        if (res.ok) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Resposta da corretora não é JSON válido', { status: res.status });
        data = text;
      }
    }
    if (!res.ok) {
      const err = classifyStatus(res.status, data);
      const ra = res.headers?.get?.('retry-after');
      if (ra && Number.isFinite(Number(ra))) err.retryAfterMs = Number(ra) * 1000;
      throw err;
    }
    return data;
  }
}
