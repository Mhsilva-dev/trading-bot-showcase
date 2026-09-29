// Reconciliação BANCO LOCAL x CORRETORA. Qualquer divergência pausa o
// trading (TRADING PAUSED) até que os dois lados batam de novo.
//
// Compara:
//   - ordens em andamento no banco  -> atualiza consultando a corretora
//   - ordens abertas na corretora   -> todas precisam ser conhecidas
//   - posição local x saldo do ativo base na corretora
//   - saldos válidos (números, não negativos)
export class Reconciler {
  constructor({ repo, broker, orderManager, accountId, log }) {
    this.repo = repo;
    this.broker = broker;
    this.orders = orderManager;
    this.accountId = accountId;
    this.log = log;
  }

  async run({ symbol, rules, ticker, fillCtx }) {
    const mismatches = [];

    // 1. Ordens locais em andamento (inclui UNKNOWN)
    for (const row of this.repo.activeOrders(this.accountId)) {
      const updated = await this.orders.refresh(row, fillCtx);
      if (updated.status === 'UNKNOWN' || updated.status === 'PENDING_SUBMIT') {
        mismatches.push(`Ordem ${row.client_order_id} ainda sem confirmação da corretora`);
      }
    }

    // 2. Ordens abertas na corretora
    const brokerOpen = await this.broker.getOpenOrders(symbol);
    const known = new Set(this.repo.activeOrders(this.accountId).flatMap((o) => [o.broker_order_id, o.client_order_id]));
    for (const o of brokerOpen) {
      if (!known.has(o.id) && !known.has(o.externalId)) mismatches.push(`Ordem ${o.id} aberta na corretora não é do bot`);
    }

    // 3. Posição x saldo
    const balances = await this.broker.getBalance();
    for (const [asset, b] of Object.entries(balances)) {
      if (![b.available, b.onHold, b.total].every((x) => Number.isFinite(x) && x >= -1e-12)) {
        mismatches.push(`Saldo inválido de ${asset}`);
      }
    }
    const brokerQty = balances[rules.base]?.total ?? 0;
    const pos = this.repo.openPosition(this.accountId, symbol);
    const localQty = pos?.quantity ?? 0;
    const diff = Math.abs(brokerQty - localQty);
    const price = ticker?.bid ?? pos?.average_price ?? 0;
    // Tolerância: diferença que não dá nem uma ordem mínima (poeira) ou < 0,5%.
    const dustTol = diff < rules.minVolume || diff * price < rules.minCost;
    const relTol = localQty > 0 && diff / localQty < 0.005;
    if (!(dustTol || relTol)) {
      mismatches.push(`Posição divergente: banco ${localQty} x corretora ${brokerQty} ${rules.base}`);
    }

    // 4. Outras ações da carteira (compras manuais em outros ativos)
    for (const extra of this.repo.listPositions(this.accountId).filter((p) => p.symbol !== symbol)) {
      const r = await this.broker.getSymbolRules(extra.symbol);
      const bq = balances[r.base]?.total ?? 0;
      if (Math.abs(bq - extra.quantity) >= r.minVolume) mismatches.push(`Posição divergente: banco ${extra.quantity} x corretora ${bq} ${r.base}`);
    }

    const ok = mismatches.length === 0;
    if (ok) this.log.info('SYSTEM', 'RECONCILE_OK', 'Reconciliação OK: banco e corretora conferem', { brokerQty, localQty });
    else this.log.error('SYSTEM', 'RECONCILE_MISMATCH', `Reconciliação divergente: ${mismatches.join('; ')}`, { mismatches, brokerQty, localQty });
    return { ok, mismatches, brokerOpenOrders: brokerOpen, balances };
  }
}
