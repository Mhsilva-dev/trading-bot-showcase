#!/usr/bin/env bash
# Copia o TradingBridge.mq5 para o MT5 e compila com o MetaEditor (Wine, sem tela).
# Uso: sudo bash mt5/compile.sh
set -euo pipefail
MT5_HOME=${MT5_HOME:-/var/lib/mt5}
MT="$MT5_HOME/.wine/drive_c/Program Files/MetaTrader 5"
SRC="$(cd "$(dirname "$0")" && pwd)/TradingBridge.mq5"
DISPLAY_NUM=${MT5_COMPILE_DISPLAY:-:78}

install -o mt5 -g mt5 -m 644 "$SRC" "$MT/MQL5/Experts/TradingBridge.mq5"
rm -f "$MT/MQL5/Experts/TradingBridge.ex5" "$MT/MQL5/Experts/TradingBridge.log"

sudo -u mt5 bash -c "Xvfb $DISPLAY_NUM -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 & echo \$! > $MT5_HOME/xvfb-compile.pid"
sleep 1
sudo -u mt5 env HOME="$MT5_HOME" WINEPREFIX="$MT5_HOME/.wine" WINEDEBUG=-all DISPLAY="$DISPLAY_NUM" bash -c \
  "cd \"$MT\" && timeout 170 /usr/lib/wine/wine64 MetaEditor64.exe /portable /compile:'MQL5\\Experts\\TradingBridge.mq5' /log:'MQL5\\Experts\\TradingBridge.log'; timeout 170 /usr/lib/wine/wineserver64 -w" || true
kill "$(cat "$MT5_HOME/xvfb-compile.pid")" 2>/dev/null || true
rm -f "$MT5_HOME/xvfb-compile.pid"

iconv -f UTF-16LE -t UTF-8 "$MT/MQL5/Experts/TradingBridge.log" | grep -E "error|warning|Result" | tail -20
[ -f "$MT/MQL5/Experts/TradingBridge.ex5" ] && echo "OK: TradingBridge.ex5 gerado" || { echo "FALHA: .ex5 não gerado"; exit 1; }
