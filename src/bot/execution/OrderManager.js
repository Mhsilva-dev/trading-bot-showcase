// Order Manager — único lugar que envia ordens. Protocolo anti-duplicidade:
//   1. consulta o banco (ordens em andamento)      -> se houver, NÃO envia
//   2. consulta a corretora (ordens abertas)       -> se houver, NÃO envia
//   3. gera id único (externalId)
//   4. registra a INTENÇÃO no banco (PENDING_SUBMIT) antes de enviar
//   5. envia (sem retry)
//   6. confirma o resultado consultando a ordem
//   7. atualiza banco + portfólio
// Se a resposta do passo 5 for ambígua (timeout, queda), a ordem fica
// UNKNOWN e o Engine só volta a operar depois de sincronizar.
import { ErrorKind, asBrokerError } from '../../broker/errors.js';
import { clientOrderId, sleep } from '../../lib/util.js';

const FINAL = new Set(['FILLED', 'CANCELED', 'REJECTED']);

export class DuplicateGuardError extends Error {
  constructor(message) { super(message); this.name = 'DuplicateGuardError'; }
}

export class OrderManager {
  constructor({ repo, broker, accountId, portfolio, log, pollAttempts = 5, pollDelayMs = 1100, notFoundGraceMs = 120_000 }) {
    this.notFoundGraceMs = notFoundGraceMs;
    this.repo = repo;
    this.broker = broker;
    this.accountId = accountId;
    this.portfolio = portfolio;
    this.log = log;
    this.pollAttempts = pollAttempts;
    this.pollDelayMs = pollDelayMs;
  }

  async submit({ symbol, side, cost, qty, purpose, fillCtx }) {
    // 1. banco
    const local = this.repo.activeOrders(this.accountId);
    if (local.length) throw new DuplicateGuardError(`Ordem ${local[0].client_order_id} ainda em andamento (${local[0].status})`);
    // 2. corretora
    const open = await this.broker.getOpenOrders(symbol);
    if (open.length) throw new DuplicateGuardError(`Corretora tem ${open.length} ordem(ns) aberta(s) em ${symbol}`);

    // 3 + 4. intenção
    const cid = clientOrderId(this.accountId);
    const intent = this.repo.insertOrderIntent({
      account_id: this.accountId, client_order_id: cid, symbol, side, type: 'market',
      quantity: qty ?? null, cost: cost ?? null, purpose,
      trade_id: side === 'SELL' ? this.portfolio.position(symbol)?.trade_id ?? null : null,
    });
    this.log.trade('ORDER_INTENT', `${side} ${symbol} ${cost ? `R$${cost.toFixed(2)}` : qty} (${purpose})`, { clientOrderId: cid, purpose });

    // 5. envio
    let bo;
    try {
      bo = await this.broker.createOrder({ symbol, side, type: 'market', qty, cost, externalId: cid });
    } catch (e) {
      const err = asBrokerError(e);
      // Erros em que a corretora certamente NÃO registrou a ordem.
      const definitelyNotPlaced = [ErrorKind.REJECTED, ErrorKind.INSUFFICIENT_FUNDS, ErrorKind.MARKET_CLOSED,
        ErrorKind.AUTH, ErrorKind.RATE_LIMIT, ErrorKind.CIRCUIT_OPEN, ErrorKind.NOT_FOUND].includes(err.kind);
      if (definitelyNotPlaced) {
        const o = this.repo.updateOrder(intent.id, { status: 'REJECTED', error: `${err.kind}: ${err.message}` });
        this.log.warn('TRADE', 'ORDER_REJECTED', `Ordem rejeitada: ${err.message}`, { clientOrderId: cid, kind: err.kind });
        return { order: o, status: 'REJECTED', error: err };
      }
      const o = this.repo.updateOrder(intent.id, { status: 'UNKNOWN', error: `${err.kind}: ${err.message}` });
      this.log.critical('TRADE', 'ORDER_UNKNOWN', `Resultado da ordem desconhecido (${err.kind}). Trading pausado até sincronizar.`, { clientOrderId: cid });
      return { order: o, status: 'UNKNOWN', error: err };
    }

    // 6 + 7. confirmação
    let row = this.applyBrokerOrder(intent, bo, fillCtx);
    for (let i = 0; i < this.pollAttempts && !FINAL.has(row.status); i++) {
      await sleep(this.pollDelayMs);
      try {
        row = this.applyBrokerOrder(row, await this.broker.getOrder(symbol, row.broker_order_id), fillCtx);
      } catch (e) {
        this.log.warn('BROKER', 'ORDER_POLL_FAILED', `Falha ao consultar ordem: ${e.message}`, { clientOrderId: cid });
      }
    }
    return { order: row, status: row.status };
  }

  // Atualiza a ordem local a partir da ordem da corretora, aplicando apenas
  // a parte NOVA executada (idempotente: chamar duas vezes não duplica).
  applyBrokerOrder(row, bo, fillCtx) {
    if (bo.externalId && bo.externalId !== row.client_order_id) {
      throw new Error(`externalId divergente: ${bo.externalId} != ${row.client_order_id}`);
    }
    return this.repo.tx(() => {
      const current = this.repo.getOrder(row.id);
      const prevQty = current.filled_quantity || 0;
      const deltaQty = +(bo.filledQty - prevQty).toFixed(12);
      const patch = { broker_order_id: bo.id };
      if (deltaQty > 0) {
        const prevNotional = (current.avg_fill_price || 0) * prevQty;
        const deltaAvg = (bo.avgPrice * bo.filledQty - prevNotional) / deltaQty;
        const dFeeBase = Math.max(bo.feeBase - current.fee_base, 0);
        const dFeeQuote = Math.max(bo.feeQuote - current.fee_quote, 0);
        const res = this.portfolio.applyFill(current, { qty: deltaQty, avgPrice: deltaAvg, feeBase: dFeeBase, feeQuote: dFeeQuote }, fillCtx);
        Object.assign(patch, {
          filled_quantity: bo.filledQty,
          avg_fill_price: bo.avgPrice,
          fee_base: bo.feeBase,
          fee_quote: bo.feeQuote,
          fees: bo.feeBase * bo.avgPrice + bo.feeQuote,
          price: bo.avgPrice,
          trade_id: res.tradeId ?? current.trade_id,
        });
        if (res.dust) this.log.info('TRADE', 'DUST', `Sobra de ${res.dust} abaixo do mínimo negociável ficou na conta`, { orderId: row.id });
      }
      let status = bo.status;
      if (status === 'OPEN' && bo.filledQty > 0) status = 'PARTIAL';
      patch.status = status;
      const updated = this.repo.updateOrder(row.id, patch);
      if (deltaQty > 0) {
        const sev = status === 'FILLED' ? 'ORDER_FILLED' : 'ORDER_PARTIAL';
        this.log.trade(sev, `${updated.side} ${updated.symbol} ${bo.filledQty} @ ${bo.avgPrice} (${updated.purpose})`, {
          orderId: updated.id, brokerOrderId: bo.id, status, fees: patch.fees,
        });
      }
      return updated;
    });
  }

  // Atualiza uma ordem em andamento consultando a corretora. Para UNKNOWN,
  // procura pelo externalId — é assim que descobrimos se ela chegou lá.
  async refresh(row, fillCtx) {
    let bo;
    if (row.broker_order_id) {
      bo = await this.broker.getOrder(row.symbol, row.broker_order_id);
    } else {
      const since = Date.parse(row.created_at) / 1000;
      bo = await this.broker.findOrderByExternalId(row.symbol, row.client_order_id, since);
      if (!bo) {
        // Dá tempo para a corretora refletir a ordem antes de concluir que ela não existe.
        if (Date.now() - Date.parse(row.created_at) < this.notFoundGraceMs) return row;
        // A corretora confirma que não existe ordem com esse id -> nunca foi criada.
        const o = this.repo.updateOrder(row.id, { status: 'REJECTED', error: 'Não encontrada na corretora após sincronização' });
        this.log.warn('TRADE', 'ORDER_NOT_FOUND', `Ordem ${row.client_order_id} não existe na corretora — marcada como não enviada`);
        return o;
      }
    }
    return this.applyBrokerOrder(row, bo, fillCtx);
  }
}
