// Classificação de erros da corretora. O tipo decide o que o bot faz:
// - retryable: pode repetir consultas (nunca criação de ordem)
// - unknownOutcome: a ordem PODE ter sido criada -> sincronizar antes de operar
export const ErrorKind = {
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMIT: 'RATE_LIMIT',
  AUTH: 'AUTH',
  REJECTED: 'REJECTED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  SERVER: 'SERVER',
  MARKET_CLOSED: 'MARKET_CLOSED',
  NOT_FOUND: 'NOT_FOUND',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  // Estados 'ociosos' (não são falha): conta sem cadastro, pregão fechado
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  STARTING: 'STARTING',
  UNKNOWN: 'UNKNOWN',
};

export class BrokerError extends Error {
  constructor(kind, message, { status, code, retryAfterMs, cause } = {}) {
    super(message);
    this.name = 'BrokerError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    if (cause) this.cause = cause;
  }

  get retryable() {
    return [ErrorKind.NETWORK, ErrorKind.TIMEOUT, ErrorKind.RATE_LIMIT, ErrorKind.SERVER].includes(this.kind);
  }

  // Em criação de ordem: não sabemos se a corretora recebeu.
  get unknownOutcome() {
    return [ErrorKind.NETWORK, ErrorKind.TIMEOUT, ErrorKind.SERVER, ErrorKind.INVALID_RESPONSE, ErrorKind.UNKNOWN].includes(this.kind);
  }
}

export function asBrokerError(err) {
  if (err instanceof BrokerError) return err;
  if (err?.kind === 'INVALID_RESPONSE') return new BrokerError(ErrorKind.INVALID_RESPONSE, err.message, { cause: err });
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return new BrokerError(ErrorKind.TIMEOUT, 'Timeout na comunicação com a corretora', { cause: err });
  if (err instanceof TypeError || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND' || err?.cause?.code) {
    return new BrokerError(ErrorKind.NETWORK, `Falha de conexão: ${err.message}`, { cause: err });
  }
  return new BrokerError(ErrorKind.UNKNOWN, err?.message || String(err), { cause: err });
}
