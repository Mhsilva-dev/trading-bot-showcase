// Tempo real via WebSocket (/ws). O painel recebe o estado das contas e
// eventos novos assim que o bot grava no banco. Se a conexão cair, o
// frontend volta a consultar a API periodicamente (fallback).
import { WebSocketServer } from 'ws';
import { accountStatus } from '../api/routes/bot.js';

export function attachRealtime({ server, sessionMiddleware, repo, config, log, intervalMs = 1000 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy();
    // Mesma sessão do HTTP: sem login, sem WebSocket.
    sessionMiddleware(req, {}, () => {
      if (!req.session?.user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.user = req.session.user.username;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', () => {}); // cliente não manda comandos por aqui
    send(ws, { type: 'hello', accounts: snapshot() });
  });

  function send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function snapshot() {
    return repo.listAccounts().map((a) => accountStatus(repo, config, a.id));
  }

  let lastEventId = repo.lastEventId();
  let lastStateKey = '';
  const timer = setInterval(() => {
    if (!wss.clients.size) return;
    try {
      const states = snapshot();
      const key = JSON.stringify(states.map((s) => [s.heartbeatAt, s.status, s.control, s.unreadAlerts]));
      if (key !== lastStateKey) {
        lastStateKey = key;
        for (const ws of wss.clients) send(ws, { type: 'state', accounts: states });
      }
      const { rows } = repo.listEvents({ afterId: lastEventId, limit: 100 });
      if (rows.length) {
        lastEventId = rows[0].id;
        const events = rows.reverse();
        for (const ws of wss.clients) send(ws, { type: 'events', events });
      }
    } catch (e) {
      log.error('SYSTEM', 'WS_ERROR', `Falha no tempo real: ${e.message}`);
    }
  }, intervalMs);

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  return { wss, close: () => { clearInterval(timer); clearInterval(ping); wss.close(); } };
}
