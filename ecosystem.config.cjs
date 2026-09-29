// PM2: dois processos independentes.
//   trading-bot        -> motor (estratégia, risco, ordens). Não expõe porta.
//   trading-dashboard  -> painel + API + WebSocket (127.0.0.1:DASHBOARD_PORT).
// Se o painel cair, o bot segue; se o bot cair, o painel mostra OFFLINE.
module.exports = {
  apps: [
    {
      name: 'trading-bot',
      script: 'src/bot/main.js',
      cwd: __dirname,
      instances: 1,          // NUNCA mais de 1: duas instâncias = risco de ordem duplicada
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      kill_timeout: 20000,   // tempo para terminar um ciclo/ordem em andamento
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      // Liga/desliga o MetaTrader 5 (XP) no horário do pregão. Precisa rodar
      // como root para iniciar o MT5 como o usuário isolado "mt5".
      name: 'trading-mt5',
      script: 'src/mt5/launcher.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 10000,
      kill_timeout: 30000,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
      out_file: './logs/mt5-out.log',
      error_file: './logs/mt5-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
    {
      name: 'trading-dashboard',
      script: 'src/server/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
      out_file: './logs/dashboard-out.log',
      error_file: './logs/dashboard-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
