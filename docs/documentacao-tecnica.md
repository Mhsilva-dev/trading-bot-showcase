# Documentação técnica

Bot de trading automatizado com **paper trading em paralelo**, backtest, gestão de risco,
reconciliação com a corretora e painel web em tempo real.

> **Aviso.** Nenhum sistema garante lucro ou ausência de erros. Este projeto busca
> **minimizar erros operacionais**, impedir ordens indevidas e **parar sozinho** diante de
> qualquer condição insegura. Resultados de backtest e paper trading não garantem
> resultados futuros.

---

## Sumário

1. [Arquitetura](#arquitetura)
2. [Instalação](#instalação)
3. [Configuração (.env)](#configuração-env)
4. [Comandos](#comandos)
5. [Corretora](#corretora)
6. [Estratégia](#estratégia)
7. [Gestão de risco](#gestão-de-risco)
8. [Proteções de execução](#proteções-de-execução)
9. [Paper trading](#paper-trading)
10. [Backtest](#backtest)
11. [Live trading](#live-trading)
12. [Painel web](#painel-web)
13. [API](#api)
14. [Banco de dados](#banco-de-dados)
15. [Segurança](#segurança)
16. [Deploy (VPS + PM2)](#deploy-vps--pm2)
17. [Testes](#testes)
18. [Troubleshooting e recuperação](#troubleshooting-e-recuperação)
19. [Ações da B3](#ações-da-b3-próxima-etapa)

---

## Arquitetura

```
Market Data ─▶ Strategy ─▶ Risk Manager ─▶ Order Manager ─▶ Broker Adapter ─▶ Corretora
                                                  │
                                                  ▼
                                          Banco (SQLite, WAL)
                                                  │
                                                  ▼
                                   Painel (API + WebSocket + React)
```

Dois processos independentes (PM2):

| Processo | Função | Porta |
|---|---|---|
| `trading-bot` | Loop de cada conta: dados → estratégia → risco → ordens → reconciliação | nenhuma |
| `trading-dashboard` | API REST, WebSocket, frontend, autenticação | `127.0.0.1:3010` |

O painel **nunca envia ordens**. Comandos (iniciar, pausar, parar...) vão para a tabela
`commands`, que o bot lê a cada segundo. Comandos que **reduzem risco** (parar, pausar,
EMERGENCY STOP) também são gravados direto em `bot_control` e valem na hora, mesmo com o
bot fora do ar.

### Estrutura

```
src/
├── bot/
│   ├── main.js              processo do bot (agendador, fila de comandos, shutdown)
│   ├── Engine.js            ciclo de uma conta + máquina de estados
│   ├── accounts.js          contas PAPER e LIVE e seus brokers
│   ├── settings.js          configurações efetivas (banco > .env)
│   ├── market/              MarketData (só candles fechados, validação, idade dos dados)
│   ├── strategy/            indicadores + estratégias (modular)
│   ├── risk/                RiskManager
│   ├── execution/           OrderManager (anti-duplicidade, UNKNOWN, parciais)
│   ├── portfolio/           Portfolio (trades, posições, P/L, métricas diárias)
│   └── reconcile/           Reconciler (banco x corretora)
├── broker/                  BrokerAdapter, MercadoBitcoinBroker, http (retry/backoff/circuit breaker)
├── paper/                   PaperBroker (simulador)
├── backtest/                Backtester + parser de CSV
├── database/                schema, conexão, repositório
├── monitoring/              logger estruturado (com máscara de segredos)
├── api/routes/              auth, bot, data, backtest
├── server/                  app Express, sessão, segurança, WebSocket
└── cli/                     status, stop, backtest, createUser
web/                         React + Vite + Tailwind + Recharts + lightweight-charts
test/                        node:test (unit, integração, falhas, API)
```

---

## Instalação

Requisitos: Node.js 20+.

```bash
cd trading-bot
npm install
npm --prefix web install
npm run web:build
cp .env.example .env         # edite: JWT_SECRET, TRADING_ENABLED...
chmod 600 .env
npm run user:create -- admin # pede a senha (mín. 12 caracteres)
npm test
```

---

## Configuração (.env)

Veja `.env.example`, onde cada variável está comentada. As principais:

| Variável | Padrão | Significado |
|---|---|---|
| `TRADING_MODE` | `paper` | `paper` = só a conta simulada. `live` = ativa também a conta real |
| `TRADING_ENABLED` | `false` | **Kill switch global.** `false` = nenhuma ordem é enviada, nem no paper |
| `LIVE_TRADING_CONFIRM` | `false` | Precisa ser `true` **junto com** `TRADING_MODE=live` |
| `API_KEY` / `API_SECRET` | — | Credenciais do Mercado Bitcoin (client_id / client_secret) |
| `INITIAL_CAPITAL` | `20` | Capital da conta PAPER (R$) |
| `MAX_POSITION_PERCENT` | `95` | % máximo do patrimônio em posição |
| `MAX_ORDER_VALUE` | `20` | R$ máximo por ordem |
| `MAX_DAILY_LOSS` | `1` | Perda máxima no dia (R$). Ao atingir, o estado vira **TRADING HALTED** até o dia seguinte |
| `MAX_DAILY_TRADES` | `4` | Máximo de entradas por dia |
| `STOP_LOSS_PERCENT` | `2` | Stop-loss abaixo do preço de entrada |
| `TAKE_PROFIT_PERCENT` | `3` | Take-profit acima do preço de entrada |
| `MAX_SPREAD_PERCENT` | `0.5` | Spread máximo aceito |
| `MIN_24H_VOLUME` | `100000` | Volume mínimo em 24h (R$) para considerar o ativo líquido |
| `STOP_MANAGE_EXITS` | `true` | Com o bot parado, continua executando stop/take da posição aberta |
| `PAPER_FEE_PERCENT` | `0.70` | Taxa simulada. É o valor de exemplo da taxa *taker* na documentação do MB; a taxa real depende da sua faixa |

**Os valores de risco padrão são exemplos conservadores para o teste de R$20, não
recomendação.** Stop, take, limites e parâmetros da estratégia podem ser alterados no
painel (com confirmação). Modo, credenciais e kill switch **só pelo `.env`**.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Painel com reload automático |
| `npm run dev:bot` | Bot com reload automático |
| `npm run web:dev` | Frontend em modo dev (Vite na porta 5173, repassa `/api` para 3010) |
| `npm test` | Todos os testes |
| `npm run backtest -- --symbol=BTC-BRL --timeframe=1h --days=90` | Backtest pelo terminal |
| `npm run backtest -- --csv=dados.csv` | Backtest com CSV próprio |
| `npm run bot:paper` | Roda o bot só em paper |
| `npm run bot:live` | Roda com `TRADING_MODE=live` (ainda exige `LIVE_TRADING_CONFIRM=true`) |
| `npm run bot:status` | Status das contas direto do banco |
| `npm run bot:stop` | Para todas as contas (sem novas entradas) |
| `npm run bot:stop -- --emergency` | **EMERGENCY STOP**: nenhuma ordem, nem de saída |
| `npm run user:create -- <usuario>` | Cria ou troca a senha de um usuário do painel |

---

## Corretora

**Mercado Bitcoin, API v4.** Todos os endpoints vêm da especificação oficial
(`https://api.mercadobitcoin.net/api/v4/docs/swagger.yaml`):

- Autenticação: `POST /oauth2/token` (`client_credentials`, `scope=global`), com o token Bearer renovado automaticamente.
- Conta: `GET /accounts`, `GET /accounts/{id}/balances` e `GET /accounts/{id}/{symbol}/fees`.
- Ordens: `POST|GET /accounts/{id}/{symbol}/orders`, `GET|DELETE /accounts/{id}/{symbol}/orders/{orderId}`.
- Dados públicos: `/symbols` (mínimos: `min-cost`, `min-volume`, `round-lot`), `/tickers`, `/candles`, `/{symbol}/orderbook`.

Para BTC-BRL, na data desta versão, o mínimo por ordem era **R$0,90**, então R$20
permitem operar. O bot **lê esses limites da API** a cada hora; não há valor fixo no
código. Se não for possível operar, ele registra **NO TRADE** com o motivo.

**Por que não a Binance?** Este servidor fica nos EUA e a Binance responde
`HTTP 451 — restricted location`. O sistema **não tenta contornar** isso com VPN ou proxy.

A camada `BrokerAdapter` (`src/broker/BrokerAdapter.js`) isola o bot da corretora. Para
adicionar outra, implemente a interface e registre em `src/bot/accounts.js`.

---

## Estratégia

**EMA Cross + RSI** (`src/bot/strategy/EmaRsiStrategy.js`). Só compra (mercado à vista),
e só é avaliada no **último candle fechado**:

- **BUY:** a EMA rápida cruza para cima da EMA lenta **e** o RSI está abaixo de `rsiBuyMax` **e** o preço está acima da EMA de tendência (se `trendPeriod` > 0).
- **SELL:** a EMA rápida cruza para baixo da lenta, **ou** o RSI passa de `rsiExit`.
- **HOLD:** qualquer outro caso.

| Parâmetro | Padrão | Significado |
|---|---|---|
| `fastPeriod` | 9 | EMA rápida |
| `slowPeriod` | 21 | EMA lenta |
| `rsiPeriod` | 14 | RSI de Wilder |
| `rsiBuyMax` | 70 | Não compra acima deste RSI |
| `rsiExit` | 80 | Vende acima deste RSI |
| `trendPeriod` | 50 | Filtro de tendência (0 desliga) |

Retorno: `{ signal, confidence, price, reason, indicators }`. **`confidence` mede a folga
das condições da estratégia; não é probabilidade de lucro.**

Stop-loss e take-profit **não** ficam na estratégia. Eles valem para qualquer estratégia
e são verificados a cada `PRICE_CHECK_INTERVAL_SECONDS`.

Para criar uma estratégia nova, implemente `{ name, label, params, minCandles(), evaluate(candles, ctx), indicatorSeries(candles) }` e registre em `src/bot/strategy/index.js`.

### Resultado do backtest com os parâmetros padrão (medido em 25/09/2026)

| Cenário | P/L | Trades | Taxas |
|---|---|---|---|
| BTC-BRL 15m, 30 dias, taxa 0,7% | **-53%** | 51 | R$10,02 |
| BTC-BRL 15m, 30 dias, **sem taxa** | +0,7% | 51 | R$0 |
| BTC-BRL 1h, 180 dias, taxa 0,7% | **-72%** | 80 | R$12,85 |

**Conclusão:** sem taxas a estratégia padrão fica perto de zero, ou seja, não mostrou
vantagem estatística nesse período. Com a taxa por execução do Mercado Bitcoin, as taxas
consomem o capital. Ela serve para **validar a execução e a segurança do sistema**, não
como fonte de lucro. Antes de usar dinheiro real, teste outras regras ou timeframes no
backtest e, principalmente, evite sobreajustar (*overfitting*) os parâmetros ao passado.

---

## Gestão de risco

O `RiskManager` (`src/bot/risk/RiskManager.js`) verifica **antes de cada ordem**:

- kill switch, bloqueio do live, EMERGENCY STOP, estado do bot (entradas só em `RUNNING`)
- banco acessível, FAIL SAFE, sincronização pendente, reconciliação divergente
- saúde da API (circuit breaker), ordens em andamento no banco e ordens abertas na corretora
- preço presente e recente (`MAX_DATA_AGE_SECONDS`), regras do ativo conhecidas, mercado aberto
- saldo conhecido, P/L do dia e limite diário, número de operações no dia
- posição já aberta, ou saldo do ativo na corretora sem posição local
- spread, volume em 24h, profundidade do livro (≥ 2× a ordem nos 10 primeiros níveis)
- tamanho da ordem: `min(saldo, patrimônio × MAX_POSITION_PERCENT, MAX_ORDER_VALUE)` ≥ mínimo da corretora
- se a posição resultante pode ser vendida depois (mínimos na saída)
- se o take-profit cobre os custos estimados (taxa de ida e volta + spread)

Decisões possíveis: `APPROVED`, `TRADE_BLOCKED`, `NO_TRADE` e `TRADING_HALTED`, sempre com o motivo registrado no log.

---

## Proteções de execução

**Princípio:** `UNKNOWN STATE → PAUSE → SYNC → VERIFY → RESUME`. Nunca `UNKNOWN → TRADE`.

### Anti-duplicidade (OrderManager)

1. consulta o banco (ordens em andamento);
2. consulta a corretora (ordens abertas);
3. gera um id único (`externalId`);
4. grava a intenção no banco (`PENDING_SUBMIT`) **antes** de enviar;
5. envia a ordem, **sem retry**;
6. confirma o resultado consultando a ordem;
7. atualiza o banco e o portfólio.

Se o envio falhar de forma ambígua (timeout, queda, erro 5xx, resposta inválida), a ordem
fica **UNKNOWN**, o bot pausa e a reconciliação procura a ordem pelo `externalId`. Se ela
existir, é aplicada. Se não existir depois de 2 minutos, é marcada como não enviada.
Execuções parciais aplicam só a parte nova, de forma idempotente.

### Reconciliação

A reconciliação roda na inicialização, depois de qualquer erro, a pedido do operador e a
cada `RECONCILE_INTERVAL_SECONDS`. Ela compara as ordens em andamento, as ordens abertas
na corretora (todas precisam ser do bot) e a posição local com o saldo do ativo, com
tolerância apenas para poeira abaixo do mínimo negociável. Qualquer divergência coloca o
bot em **TRADING PAUSED**.

### Erros

- Consultas usam **retry limitado** (3 tentativas) com **backoff exponencial**, e respeitam `Retry-After`.
- O **circuit breaker** abre depois de 5 falhas seguidas e fica 60s em cooldown.
- Rate limit por endpoint segue os limites da documentação oficial.
- Erro de autenticação, banco indisponível ou 5 erros seguidos no ciclo levam a **FAIL SAFE**: novas ordens ficam bloqueadas até uma sincronização manual (ou até corrigir as credenciais e reiniciar).

### Kill switch e emergência

| Ação | Efeito |
|---|---|
| `TRADING_ENABLED=false` | Nenhuma ordem, em nenhuma conta |
| ⏸ Pausar / 🛑 Parar | Sem novas entradas. Stop e take da posição aberta continuam se `STOP_MANAGE_EXITS=true` |
| **EMERGENCY STOP** | Nenhuma ordem, inclusive de saída. Persiste depois de reiniciar. Para liberar, é preciso uma ação explícita, e o bot volta **parado** |

### Reinicialização

A cada inicialização o bot carrega o banco, conecta na corretora, lê saldos, posições e
ordens, reconcilia e só então permite operar. Um estado `RUNNING` anterior só é retomado
depois da reconciliação OK.

---

## Paper trading

A conta **PAPER** roda **sempre**, em paralelo com a LIVE, com saldo, ordens e histórico
separados:

- usa preços **reais** da API pública do Mercado Bitcoin;
- compra no *ask* e vende no *bid*, com slippage (`PAPER_SLIPPAGE_PERCENT`) e taxa (`PAPER_FEE_PERCENT`);
- aplica as mesmas regras de mínimo, passo de quantidade e saldo da corretora real;
- guarda o estado no banco, então sobrevive a reinícios;
- pode ser resetado no painel (com confirmação e com o bot parado).

No painel, o seletor **PAPER / LIVE** no topo troca todas as telas de conta.

---

## Backtest

O sinal é gerado no fechamento do candle *i* e executado na **abertura do candle *i+1***,
sem olhar o futuro. A simulação usa taxa, slippage, stop e take intra-candle. Quando o
stop e o alvo são tocados no mesmo candle, conta o stop (hipótese conservadora). Se o
preço abre além do alvo (gap), a execução é no preço de abertura.

Fontes de dados: a API pública do Mercado Bitcoin (máx. 20.000 candles por execução) ou
um **CSV** com as colunas `date,open,high,low,close,volume`. O CSV permite, por exemplo,
testar ações da B3.

Resultado: capital inicial e final, P/L em reais e %, trades, wins e losses, taxas,
drawdown máximo, maior ganho e maior perda, além de curvas de equity, P/L acumulado e
drawdown.

---

## Live trading

**Não é habilitado automaticamente.** A sequência obrigatória:

1. `npm test` passando
2. backtest
3. paper trading por um período
4. conferência do painel, dos logs e das reconciliações
5. só então o live

Para ativar:

```bash
# 1. Crie a chave no Mercado Bitcoin SOMENTE com permissão de negociação (SEM saque).
# 2. No .env:
TRADING_MODE=live
LIVE_TRADING_CONFIRM=true
TRADING_ENABLED=true
API_KEY=<client_id>
API_SECRET=<client_secret>
# 3. Configure os limites da conta LIVE no painel (Configurações, com LIVE selecionado).
# 4. Reinicie o bot:
pm2 restart trading-bot
# 5. No painel, selecione LIVE e clique Iniciar (há uma confirmação extra).
```

Sem essas variáveis, a conta LIVE aparece como **LIVE TRADING BLOCKED** e o motivo é
exibido. **Use uma conta dedicada ao bot**: saldo de BTC comprado por fora gera
divergência na reconciliação, que pausa o trading.

O objetivo do primeiro teste com R$20 é **validar execução e segurança**, não lucro.

---

## Painel web

O painel é mobile-first e em dark mode. No celular usa navegação inferior; no desktop,
menu lateral. Ele recebe dados em tempo real por WebSocket e, se a conexão cair, passa a
consultar a API a cada 5s.

| Tela | Conteúdo |
|---|---|
| Visão geral | cards (saldo, patrimônio, P/L, drawdown, taxas, operações, wins/losses, win rate), candlestick com EMAs, volume, pontos de compra/venda e stop/take, patrimônio × tempo (1H a Tudo), P/L acumulado (hoje, semana, mês, período), status, posição, últimas operações, controles |
| Operações | tabela com filtros (data, ativo, BUY/SELL, WIN/LOSS), paginação e CSV |
| Ordens | ID, lado, preço, quantidade, status (OPEN, FILLED, PARTIAL, CANCELED, REJECTED, UNKNOWN), datas e Broker ID |
| Posições | quantidade, preço médio e atual, P/L aberto (R$ e %), stop, alvo e histórico |
| Estratégia | estratégia atual, indicadores, parâmetros, último sinal com motivo e sinais recentes (filtro BUY/SELL/HOLD) |
| Risco | Risk Status (NORMAL, BLOCKED ou HALTED, com motivo), capital, exposição, perda diária x limite, drawdown e operações restantes |
| Logs | filtros por nível e categoria, detalhes em JSON, CSV |
| Backtest | parâmetros, métricas, gráficos e histórico de execuções |
| Paper Trading | saldo virtual, patrimônio, P/L, posição, ordens, operações e reset |
| Configurações | trading, risco e sistema, com confirmação ao salvar |

O sino no topo abre os alertas: compra e venda executadas, stop, take, erro, API offline,
reconciliação divergente, limite diário, bot parado, emergência e ordem desconhecida. Para
integrar notificações externas (Telegram, e-mail), adicione uma função em
`logger.notifiers`, que é chamada em todo alerta.

---

## API

Todas as rotas `/api/*` exigem sessão. As que alteram estado exigem também o header
`X-CSRF-Token`.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Público: `{status, bot, database, broker, trading}` |
| POST | `/api/auth/login` · `/api/auth/logout` | Sessão |
| GET | `/api/auth/me` | Usuário e token CSRF |
| GET | `/api/accounts` | Contas com status |
| GET | `/api/bot/status?account=paper` | `status, mode, balance, equity, position, dailyPnL, totalPnL, lastSignal, lastTrade, riskStatus...` |
| POST | `/api/bot/command` | `{account, command: start/pause/stop/sync/emergency_stop/clear_emergency/reset_paper, confirm}` |
| GET | `/api/bot/command/:id` | Resultado do comando |
| GET / PUT | `/api/settings` | Configurações. O PUT exige `confirm: true` |
| GET | `/api/strategy` · `/api/risk` · `/api/metrics` | Telas de estratégia, risco e métricas |
| GET | `/api/executions` · `/api/trades` · `/api/orders` · `/api/positions` · `/api/signals` · `/api/events` | Listas com filtros e paginação |
| GET | `/api/equity?range=1H/6H/1D/7D/30D/ALL` · `/api/pnl` · `/api/candles` | Gráficos |
| GET / POST | `/api/alerts` · `/api/alerts/read` | Alertas |
| POST | `/api/backtest` · `/api/backtest/csv` | Backtest |
| GET | `/api/export/{trades,orders,history,metrics}.csv` | Exportação |

---

## Banco de dados

SQLite (`data/trading.db`) em modo WAL: bot e painel acessam ao mesmo tempo. As
migrações são versionadas por `PRAGMA user_version` (`src/database/schema.js`).

Tabelas principais: `trades`, `orders`, `positions`, `bot_events`, `daily_metrics` e
`strategy_signals`. Tabelas de apoio: `accounts`, `settings`, `bot_state` (estado atual,
escrito pelo bot), `bot_control` (estado desejado pelo operador), `commands`,
`equity_snapshots`, `market_candles`, `paper_balances`, `paper_orders`, `users`,
`sessions` e `backtests`.

**Backup:**

```bash
sqlite3 data/trading.db ".backup 'backups/trading-$(date +%F).db'"
```

---

## Segurança

- Segredos ficam **só no `.env`** (`chmod 600`, no `.gitignore`). Nunca são enviados ao frontend.
- O logger mascara chaves, tokens, senhas e os valores de `API_KEY`/`API_SECRET` em qualquer mensagem.
- O painel escuta em `127.0.0.1`. Acesso por túnel SSH ou por nginx com HTTPS.
- Senhas usam bcrypt (custo 12). O login compara em tempo constante e tem rate limit de 10 tentativas a cada 15 min. A sessão é regenerada a cada login.
- Cookie `httpOnly`, `SameSite=strict` e `secure` quando `COOKIE_SECURE=true`. As sessões ficam no SQLite, com validade de 12h.
- CSRF é verificado por token em todas as mutações. O login confere o header `Origin`.
- Headers de segurança com Helmet (CSP restrita, `frame-ancestors 'none'`, HSTS quando há HTTPS).
- Toda entrada é validada com zod (esquemas estritos: chaves desconhecidas são recusadas).
- O React escapa o conteúdo contra XSS. Não há `dangerouslySetInnerHTML`.
- Exportação CSV protegida contra injeção de fórmula (`=`, `+`, `-` e `@`).
- Rate limit geral de 600 requisições por minuto por IP na API.
- O WebSocket exige a mesma sessão do HTTP e confere o `Origin`.

---

## Deploy (VPS + PM2)

```bash
cd trading-bot
npm ci && npm --prefix web ci && npm run web:build
pm2 start ecosystem.config.cjs
pm2 save
```

**Acesso ao painel (recomendado): túnel SSH**, sem nada exposto na internet:

```bash
# no seu computador:
ssh -L 3010:127.0.0.1:3010 root@<ip-da-vps>
# e abra http://localhost:3010
```

**Opcional: subdomínio com HTTPS** (nginx do CloudPanel):

```nginx
location / {
  proxy_pass http://127.0.0.1:3010;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

Nesse caso, coloque `COOKIE_SECURE=true` no `.env` e reinicie o `trading-dashboard`.

**Atualizar:** rode `git pull`, depois `npm ci`, depois `npm run web:build`, e por fim
`pm2 restart trading-dashboard trading-bot`. O bot reconcilia sozinho ao voltar.

---

## Testes

```bash
npm test
```

| Arquivo | Cobertura |
|---|---|
| `strategy.test.js` | SMA, EMA e RSI (com valor de referência do Wilder), sinais BUY/SELL/HOLD, parâmetros inválidos |
| `risk.test.js` | Aprovação e **cada motivo de bloqueio**: kill switch, live, emergência, banco, sync, API, ordens, dados velhos, mercado fechado, limite diário, spread, liquidez, mínimos, custos |
| `paper.test.js` | Taxas, slippage, mínimos, saldo insuficiente, `externalId` duplicado, persistência, reset |
| `orders.test.js` | Anti-duplicidade (banco e corretora), timeout antes e depois do envio, rejeições, parciais idempotentes, reconciliação |
| `engine.test.js` | Fluxo completo, stop, take, kill switch, emergência, API caiu, FAIL SAFE, autenticação, resposta inválida, rate limit, ordem duplicada, **reinício**, divergência, limite diário, saldo insuficiente, **banco indisponível**, reset |
| `broker.test.js` | Mercado Bitcoin com `fetch` simulado: OAuth2, normalização, **sem retry ao criar ordem**, backoff, 429, circuit breaker, JSON inválido, 401, máscara de segredos |
| `backtest.test.js` | Execução no candle seguinte, take, stop prioritário, gap, mínimo, CSV |
| `api.test.js` | Health, login, Origin, CSRF, autorização, status, emergência, live bloqueado, validação de configurações, CSV, logs, WebSocket autenticado, logout |

---

## Troubleshooting e recuperação

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Painel mostra **OFFLINE** | Processo do bot parado ou travado | `pm2 status`, depois `pm2 logs trading-bot`, depois `pm2 restart trading-bot` |
| **SYNCING** o tempo todo | API instável ou erro repetido | Veja em Logs os eventos `BROKER_OFFLINE`/`ERROR`. O bot tenta de novo a cada ciclo |
| **FAIL SAFE** | Autenticação, banco ou 5 erros seguidos | Corrija a causa e clique em **Sincronizar**. Se for autenticação: corrija o `.env` e `pm2 restart trading-bot` |
| **TRADING PAUSED: reconciliação divergente** | Saldo ou ordem mexidos por fora, ou ordem não confirmada | Veja o motivo no topo e em Logs. Deixe a conta como o bot espera (cancele ordens estranhas, venda ou compre a diferença manualmente) e clique em **Sincronizar** |
| Ordem **UNKNOWN** | Timeout ou queda no envio | Automático: o bot procura a ordem pelo `externalId` e resolve. Não opera até lá |
| **TRADING HALTED** | Limite de perda diária | Volta sozinho no dia seguinte (fuso `TIMEZONE`). Não "zere" o limite para continuar perdendo |
| **NO TRADE** nos logs | Saldo abaixo do mínimo, custos maiores que o alvo, quantidade mínima | Leia o motivo. Não é erro, é o bot recusando uma operação inviável |
| Não consigo entrar | Senha | `npm run user:create -- admin` redefine a senha |
| Precisa parar **agora** | — | Botão **EMERGENCY STOP** ou `npm run bot:stop -- --emergency` (funciona mesmo com o painel fora) |

**Servidor reiniciou?** O PM2 sobe os processos e o bot reconcilia antes de operar. Nada é
assumido do estado anterior.

---

## Conexões (conta XP / MT5)

Na tela **Conexões** do painel você cadastra os dados do MetaTrader 5 da XP: ambiente
(DEMO ou REAL), servidor, número da conta e senha **do MT5**. Nunca use a senha do
app ou site da XP nem a assinatura eletrônica.

- A senha é cifrada com AES-256-GCM, usando a chave `CREDENTIALS_KEY` do `.env`. O banco guarda só o texto cifrado, amarrado ao provedor.
- A API nunca devolve a senha. O login aparece mascarado (`*****678`) no painel e nos logs.
- Salvar ou remover exige redigitar a senha do painel, com rate limit de 10 tentativas a cada 15 min, e fica registrado no log `[SECURITY]`.
- Cadastrar uma conta REAL exige confirmação extra.
- Só o backend decifra, por `getBrokerCredential()`, para uso da ponte MT5.
- Se a `CREDENTIALS_KEY` for perdida, os dados precisam ser cadastrados de novo.

## Ações da B3 (próxima etapa)

Corretoras brasileiras (XP, Genial, BTG) só oferecem automação oficial pelo
**MetaTrader 5**, que precisa de Windows. O plano é criar um robô MQL5 "ponte", que apenas
executa ordens aprovadas pelo Risk Manager e se comunica com esta API por `WebRequest`, e
testá-lo primeiro na **conta demo MT5 da XP**. Com R$20, só o **mercado fracionário**
(código com final `F`) é viável, e só com o pregão aberto. Enquanto isso, a tela de
Backtest aceita CSV com histórico de ações.
