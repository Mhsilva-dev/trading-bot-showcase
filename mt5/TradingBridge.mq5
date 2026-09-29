//+------------------------------------------------------------------+
//| TradingBridge.mq5                                                  |
//| Ponte entre o MetaTrader 5 e o trading-bot (Node.js).             |
//|                                                                    |
//| NÃO toma decisões. Apenas:                                         |
//|  - publica estado (conta, posições, ordens, cotações) a cada 1s   |
//|    em MQL5/Files/bridge/state.json                                 |
//|  - publica candles em bridge/rates_<SIMBOLO>_<TF>.json            |
//|  - executa comandos gravados pelo bot em bridge/in/*.txt e grava  |
//|    o resultado em bridge/out/<id>.json                             |
//|                                                                    |
//| Proteções locais (além das do bot):                                |
//|  - comando mais velho que InpMaxCmdAgeSec é recusado              |
//|  - id já processado nunca é executado de novo (out/<id>.json)     |
//|  - conta REAL só opera se o comando trouxer allow_real=1 E        |
//|    InpAllowReal=true                                               |
//+------------------------------------------------------------------+
#property copyright "trading-bot"
#property version   "1.00"
#property strict

input int    InpTimerMs       = 1000;   // intervalo do ciclo (ms)
input int    InpMaxCmdAgeSec  = 30;     // idade máxima de um comando
input bool   InpAllowReal     = false;  // permite operar conta REAL
input long   InpMagic         = 20260925;
input int    InpRatesBars     = 300;    // candles publicados por símbolo
input int    InpDeviation     = 20;     // desvio máximo (pontos)

string BR = "bridge\\";
datetime g_lastRates = 0;

//--- utilidades -----------------------------------------------------
string Esc(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   return s;
}
string Q(string s)          { return "\"" + Esc(s) + "\""; }
string D(double v, int d=8) { return DoubleToString(v, d); }
string B(bool v)            { return v ? "true" : "false"; }

// Gravação atômica: .tmp e depois renomeia.
bool WriteAtomic(string name, string content)
{
   string tmp = name + ".tmp";
   int h = FileOpen(tmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return false;
   FileWriteString(h, content);
   FileClose(h);
   return FileMove(tmp, 0, name, FILE_REWRITE);
}

string ReadAll(string name)
{
   int h = FileOpen(name, FILE_READ | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return "";
   string s = "";
   while(!FileIsEnding(h)) s += FileReadString(h) + "\n";
   FileClose(h);
   return s;
}

// Formato do comando: linhas chave=valor
string KV(string text, string key)
{
   string lines[];
   int n = StringSplit(text, '\n', lines);
   for(int i = 0; i < n; i++)
   {
      int p = StringFind(lines[i], "=");
      if(p > 0 && StringSubstr(lines[i], 0, p) == key)
      {
         string v = StringSubstr(lines[i], p + 1);
         StringTrimRight(v); StringTrimLeft(v);
         return v;
      }
   }
   return "";
}

// Símbolos acompanhados: bridge/symbols.txt (um por linha), escrito pelo bot.
int Watchlist(string &out[])
{
   ArrayResize(out, 0);
   string s = ReadAll(BR + "symbols.txt");
   string lines[];
   int n = StringSplit(s, '\n', lines);
   for(int i = 0; i < n; i++)
   {
      string sym = lines[i];
      StringTrimLeft(sym); StringTrimRight(sym);
      if(StringLen(sym) < 3) continue;
      SymbolSelect(sym, true);
      MarketBookAdd(sym); // assina o livro de ofertas (idempotente)
      int k = ArraySize(out);
      ArrayResize(out, k + 1);
      out[k] = sym;
   }
   return ArraySize(out);
}

// Sessão de negociação aberta agora (horário do servidor)?
bool SessionOpen(string sym)
{
   datetime now = TimeTradeServer();
   MqlDateTime t; TimeToStruct(now, t);
   int secs = t.hour * 3600 + t.min * 60 + t.sec;
   datetime from, to;
   for(uint i = 0; i < 10; i++)
   {
      if(!SymbolInfoSessionTrade(sym, (ENUM_DAY_OF_WEEK)t.day_of_week, i, from, to)) break;
      int f = (int)(from % 86400), e = (int)(to % 86400);
      if(e == 0) e = 86400;
      if(secs >= f && secs < e) return true;
   }
   return false;
}

//--- estado ---------------------------------------------------------
string SymbolJson(string sym)
{
   MqlTick tk;
   bool hasTick = SymbolInfoTick(sym, tk);
   long tradeMode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   string j = "{";
   j += "\"symbol\":" + Q(sym);
   j += ",\"bid\":" + D(hasTick ? tk.bid : 0, 4);
   j += ",\"ask\":" + D(hasTick ? tk.ask : 0, 4);
   j += ",\"last\":" + D(hasTick ? tk.last : 0, 4);
   j += ",\"tick_time\":" + IntegerToString(hasTick ? (long)tk.time : 0);
   j += ",\"volume_min\":" + D(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 4);
   j += ",\"volume_max\":" + D(SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 4);
   j += ",\"volume_step\":" + D(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 4);
   j += ",\"contract_size\":" + D(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 4);
   j += ",\"tick_size\":" + D(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 6);
   j += ",\"turnover\":" + D(SymbolInfoDouble(sym, SYMBOL_SESSION_TURNOVER), 2);
   j += ",\"trade_mode\":" + IntegerToString(tradeMode);
   j += ",\"trade_full\":" + B(tradeMode == SYMBOL_TRADE_MODE_FULL);
   j += ",\"session_open\":" + B(SessionOpen(sym));
   j += ",\"currency\":" + Q(SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT));
   // Livro: até 10 níveis de cada lado
   string asks = "", bids = "";
   int na = 0, nb = 0;
   MqlBookInfo book[];
   if(MarketBookGet(sym, book))
   {
      // O array vem do maior para o menor preço: asks em cima, bids embaixo.
      for(int i = ArraySize(book) - 1; i >= 0 && na < 10; i--)
         if(book[i].type == BOOK_TYPE_SELL || book[i].type == BOOK_TYPE_SELL_MARKET)
         { asks += (na++ > 0 ? "," : "") + "[" + D(book[i].price, 4) + "," + D(book[i].volume_real, 2) + "]"; }
      for(int i = 0; i < ArraySize(book) && nb < 10; i++)
         if(book[i].type == BOOK_TYPE_BUY || book[i].type == BOOK_TYPE_BUY_MARKET)
         { bids += (nb++ > 0 ? "," : "") + "[" + D(book[i].price, 4) + "," + D(book[i].volume_real, 2) + "]"; }
   }
   j += ",\"asks\":[" + asks + "],\"bids\":[" + bids + "]";
   j += "}";
   return j;
}

void WriteState()
{
   string syms[];
   int ns = Watchlist(syms);
   string j = "{";
   j += "\"ts\":" + IntegerToString((long)TimeGMT());
   j += ",\"server_time\":" + IntegerToString((long)TimeTradeServer());
   j += ",\"connected\":" + B(TerminalInfoInteger(TERMINAL_CONNECTED) != 0);
   j += ",\"terminal_trade_allowed\":" + B(TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0);
   j += ",\"ea_trade_allowed\":" + B(MQLInfoInteger(MQL_TRADE_ALLOWED) != 0);
   j += ",\"allow_real\":" + B(InpAllowReal);
   j += ",\"account\":{";
   j += "\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   j += ",\"server\":" + Q(AccountInfoString(ACCOUNT_SERVER));
   j += ",\"company\":" + Q(AccountInfoString(ACCOUNT_COMPANY));
   j += ",\"currency\":" + Q(AccountInfoString(ACCOUNT_CURRENCY));
   j += ",\"trade_mode\":" + IntegerToString(AccountInfoInteger(ACCOUNT_TRADE_MODE)); // 0 demo, 1 contest, 2 real
   j += ",\"margin_mode\":" + IntegerToString(AccountInfoInteger(ACCOUNT_MARGIN_MODE)); // 0 netting B3
   j += ",\"trade_allowed\":" + B(AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) != 0);
   j += ",\"balance\":" + D(AccountInfoDouble(ACCOUNT_BALANCE), 2);
   j += ",\"equity\":" + D(AccountInfoDouble(ACCOUNT_EQUITY), 2);
   j += ",\"margin_free\":" + D(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2);
   j += "}";

   j += ",\"positions\":[";
   int np = 0;
   for(int i = 0; i < PositionsTotal(); i++)
   {
      string ps = PositionGetSymbol(i);
      if(ps == "") continue;
      if(np++ > 0) j += ",";
      j += "{\"symbol\":" + Q(ps);
      j += ",\"ticket\":" + IntegerToString(PositionGetInteger(POSITION_TICKET));
      j += ",\"type\":" + Q(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? "BUY" : "SELL");
      j += ",\"volume\":" + D(PositionGetDouble(POSITION_VOLUME), 4);
      j += ",\"price_open\":" + D(PositionGetDouble(POSITION_PRICE_OPEN), 4);
      j += ",\"magic\":" + IntegerToString(PositionGetInteger(POSITION_MAGIC));
      j += "}";
   }
   j += "]";

   j += ",\"orders\":[";
   int no = 0;
   for(int i = 0; i < OrdersTotal(); i++)
   {
      ulong t = OrderGetTicket(i);
      if(t == 0) continue;
      if(no++ > 0) j += ",";
      j += "{\"ticket\":" + IntegerToString((long)t);
      j += ",\"symbol\":" + Q(OrderGetString(ORDER_SYMBOL));
      j += ",\"type\":" + IntegerToString(OrderGetInteger(ORDER_TYPE));
      j += ",\"volume\":" + D(OrderGetDouble(ORDER_VOLUME_CURRENT), 4);
      j += ",\"comment\":" + Q(OrderGetString(ORDER_COMMENT));
      j += ",\"magic\":" + IntegerToString(OrderGetInteger(ORDER_MAGIC));
      j += "}";
   }
   j += "]";

   j += ",\"symbols\":[";
   for(int i = 0; i < ns; i++) { if(i > 0) j += ","; j += SymbolJson(syms[i]); }
   j += "]}";
   WriteAtomic(BR + "state.json", j);
}

void WriteRates()
{
   string syms[];
   int ns = Watchlist(syms);
   for(int s = 0; s < ns; s++)
   {
      MqlRates r[];
      ArraySetAsSeries(r, false);
      int n = CopyRates(syms[s], PERIOD_M15, 0, InpRatesBars, r);
      if(n <= 0) continue;
      string t = "", o = "", h = "", l = "", c = "", v = "";
      for(int i = 0; i < n; i++)
      {
         string sep = i > 0 ? "," : "";
         t += sep + IntegerToString((long)r[i].time);
         o += sep + D(r[i].open, 4); h += sep + D(r[i].high, 4);
         l += sep + D(r[i].low, 4);  c += sep + D(r[i].close, 4);
         v += sep + IntegerToString(r[i].real_volume > 0 ? r[i].real_volume : r[i].tick_volume);
      }
      string j = "{\"symbol\":" + Q(syms[s]) + ",\"tf\":\"15m\",\"ts\":" + IntegerToString((long)TimeGMT())
               + ",\"t\":[" + t + "],\"o\":[" + o + "],\"h\":[" + h + "],\"l\":[" + l + "],\"c\":[" + c + "],\"v\":[" + v + "]}";
      WriteAtomic(BR + "rates_" + syms[s] + "_15m.json", j);
   }
}

//--- execução -------------------------------------------------------
ENUM_ORDER_TYPE_FILLING Filling(string sym)
{
   long fm = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   if((fm & SYMBOL_FILLING_FOK) == SYMBOL_FILLING_FOK) return ORDER_FILLING_FOK;
   if((fm & SYMBOL_FILLING_IOC) == SYMBOL_FILLING_IOC) return ORDER_FILLING_IOC;
   return ORDER_FILLING_RETURN;
}

string Result(string id, bool ok, string msg, uint retcode, ulong order, ulong deal, double price, double volume, double commission, double fee, string comment)
{
   return "{\"id\":" + Q(id) + ",\"ok\":" + B(ok) + ",\"message\":" + Q(msg)
        + ",\"retcode\":" + IntegerToString(retcode) + ",\"order\":" + IntegerToString((long)order)
        + ",\"deal\":" + IntegerToString((long)deal) + ",\"price\":" + D(price, 4) + ",\"volume\":" + D(volume, 4)
        + ",\"commission\":" + D(commission, 2) + ",\"fee\":" + D(fee, 2) + ",\"comment\":" + Q(comment)
        + ",\"ts\":" + IntegerToString((long)TimeGMT()) + "}";
}

string ExecOrder(string id, string text)
{
   string sym = KV(text, "symbol");
   string side = KV(text, "side");
   double vol = StringToDouble(KV(text, "volume"));
   string comment = KV(text, "comment");
   bool allowReal = KV(text, "allow_real") == "1";

   if(AccountInfoInteger(ACCOUNT_TRADE_MODE) == ACCOUNT_TRADE_MODE_REAL && !(allowReal && InpAllowReal))
      return Result(id, false, "Conta REAL bloqueada na ponte", 0, 0, 0, 0, 0, 0, 0, comment);
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) return Result(id, false, "Terminal desconectado", 0, 0, 0, 0, 0, 0, 0, comment);
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
      return Result(id, false, "AutoTrading desabilitado no terminal", 0, 0, 0, 0, 0, 0, 0, comment);
   if(side != "BUY" && side != "SELL") return Result(id, false, "Lado inválido", 0, 0, 0, 0, 0, 0, 0, comment);
   if(vol <= 0) return Result(id, false, "Volume inválido", 0, 0, 0, 0, 0, 0, 0, comment);
   if(!SymbolSelect(sym, true)) return Result(id, false, "Símbolo inexistente", 0, 0, 0, 0, 0, 0, 0, comment);

   MqlTradeRequest req; MqlTradeResult res;
   ZeroMemory(req); ZeroMemory(res);
   req.action = TRADE_ACTION_DEAL;
   req.symbol = sym;
   req.volume = vol;
   req.type = side == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   req.price = side == "BUY" ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
   req.deviation = InpDeviation;
   req.type_filling = Filling(sym);
   req.type_time = ORDER_TIME_DAY;
   req.magic = InpMagic;
   req.comment = comment;

   bool sent = OrderSend(req, res);
   double price = res.price, volume = res.volume, commission = 0, fee = 0;
   if(res.deal > 0 && HistoryDealSelect(res.deal))
   {
      price = HistoryDealGetDouble(res.deal, DEAL_PRICE);
      volume = HistoryDealGetDouble(res.deal, DEAL_VOLUME);
      commission = HistoryDealGetDouble(res.deal, DEAL_COMMISSION);
      fee = HistoryDealGetDouble(res.deal, DEAL_FEE);
   }
   bool ok = sent && (res.retcode == TRADE_RETCODE_DONE || res.retcode == TRADE_RETCODE_DONE_PARTIAL || res.retcode == TRADE_RETCODE_PLACED);
   return Result(id, ok, res.comment, res.retcode, res.order, res.deal, price, volume, commission, fee, comment);
}

// Procura no histórico uma ordem pelo comentário (externalId do bot).
string ExecFind(string id, string text)
{
   string comment = KV(text, "comment");
   HistorySelect(TimeCurrent() - 7 * 86400, TimeCurrent() + 3600);
   for(int i = HistoryDealsTotal() - 1; i >= 0; i--)
   {
      ulong d = HistoryDealGetTicket(i);
      if(d == 0 || HistoryDealGetString(d, DEAL_COMMENT) != comment) continue;
      return Result(id, true, "found", TRADE_RETCODE_DONE, (ulong)HistoryDealGetInteger(d, DEAL_ORDER), d,
                    HistoryDealGetDouble(d, DEAL_PRICE), HistoryDealGetDouble(d, DEAL_VOLUME),
                    HistoryDealGetDouble(d, DEAL_COMMISSION), HistoryDealGetDouble(d, DEAL_FEE), comment);
   }
   return Result(id, false, "not_found", 0, 0, 0, 0, 0, 0, 0, comment);
}

// Histórico longo sob demanda (backtest): grava bridge/hist_<símbolo>_<tf>.json.
string ExecHistory(string id, string text)
{
   string sym = KV(text, "symbol");
   string tf = KV(text, "tf");
   int bars = (int)StringToInteger(KV(text, "bars"));
   ENUM_TIMEFRAMES p = tf == "5m" ? PERIOD_M5 : tf == "1h" ? PERIOD_H1 : tf == "1d" ? PERIOD_D1 : PERIOD_M15;
   if(bars <= 0 || bars > 50000) bars = 5000;
   if(!SymbolSelect(sym, true)) return Result(id, false, "Símbolo inexistente", 0, 0, 0, 0, 0, 0, 0, "");
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(sym, p, 0, bars, r);
   if(n <= 0) return Result(id, false, "Sem histórico (" + IntegerToString(GetLastError()) + ")", 0, 0, 0, 0, 0, 0, 0, "");
   string t = "", o = "", h = "", l = "", c = "", v = "";
   for(int i = 0; i < n; i++)
   {
      string sep = i > 0 ? "," : "";
      t += sep + IntegerToString((long)r[i].time);
      o += sep + D(r[i].open, 4); h += sep + D(r[i].high, 4);
      l += sep + D(r[i].low, 4);  c += sep + D(r[i].close, 4);
      v += sep + IntegerToString(r[i].real_volume > 0 ? r[i].real_volume : r[i].tick_volume);
   }
   WriteAtomic(BR + "hist_" + sym + "_" + tf + ".json", "{\"symbol\":" + Q(sym) + ",\"tf\":" + Q(tf)
      + ",\"t\":[" + t + "],\"o\":[" + o + "],\"h\":[" + h + "],\"l\":[" + l + "],\"c\":[" + c + "],\"v\":[" + v + "]}");
   return Result(id, true, "bars=" + IntegerToString(n), 0, 0, 0, 0, n, 0, 0, "");
}

void ProcessCommands()
{
   string name;
   // Build 6230+ recusa curinga "*.cmd" e arquivos .cmd (erro 5002): lista
   // tudo e filtra .txt (o .tmp da escrita atômica é ignorado).
   long h = FileFindFirst(BR + "in\\*", name);
   if(h == INVALID_HANDLE) return;
   do
   {
      int nl = StringLen(name);
      if(nl < 5 || StringSubstr(name, nl - 4) != ".txt") continue;
      string path = BR + "in\\" + name;
      string text = ReadAll(path);
      string id = KV(text, "id");
      string out = BR + "out\\" + id + ".json";
      string res;
      if(id == "" || StringLen(id) > 64) res = "";
      else if(FileIsExist(out)) res = "";  // já processado: nunca executa de novo
      else
      {
         long ts = StringToInteger(KV(text, "ts"));
         string type = KV(text, "type");
         if(MathAbs((long)TimeGMT() - ts) > InpMaxCmdAgeSec) res = Result(id, false, "Comando expirado", 0, 0, 0, 0, 0, 0, 0, KV(text, "comment"));
         else if(type == "order") res = ExecOrder(id, text);
         else if(type == "find") res = ExecFind(id, text);
         else if(type == "history") res = ExecHistory(id, text);
         else res = Result(id, false, "Tipo de comando desconhecido", 0, 0, 0, 0, 0, 0, 0, "");
      }
      if(res != "") WriteAtomic(out, res);
      FileDelete(path);
   }
   while(FileFindNext(h, name));
   FileFindClose(h);
}

//--- ciclo ----------------------------------------------------------
int OnInit()
{
   Print("TradingBridge: OnInit em ", _Symbol);
   FolderCreate("bridge");
   WriteAtomic(BR + "boot.json", "{\"ts\":" + IntegerToString((long)TimeGMT()) + ",\"symbol\":\"" + _Symbol + "\"}");
   FolderCreate(BR + "in");
   FolderCreate(BR + "out");
   EventSetMillisecondTimer(InpTimerMs);
   WriteState();
   Print("TradingBridge iniciado");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   WriteAtomic(BR + "state.json", "{\"ts\":" + IntegerToString((long)TimeGMT()) + ",\"stopped\":true,\"connected\":false}");
}

void OnTimer()
{
   ProcessCommands();   // primeiro os comandos: menor latência
   WriteState();
   if(TimeCurrent() - g_lastRates >= 15) { WriteRates(); g_lastRates = TimeCurrent(); }
}
