// Janela em que o MT5 deve ficar ligado: dias úteis, horário de Brasília.
// Feriados da B3 não estão aqui — nesses dias o próprio MT5 informa a
// sessão fechada e o Risk Manager bloqueia (o terminal só fica ocioso).
export function brasiliaParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { weekday: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
};

export function mt5ShouldRun(mt5cfg, date = new Date()) {
  if (mt5cfg.alwaysOn) return true;
  const { weekday, minutes } = brasiliaParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return minutes >= toMin(mt5cfg.startTime) && minutes < toMin(mt5cfg.stopTime);
}
