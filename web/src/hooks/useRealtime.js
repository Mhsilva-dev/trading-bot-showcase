import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api.js';

// WebSocket com reconexão (backoff) e fallback para polling da API
// enquanto o tempo real estiver fora.
export function useRealtime(enabled) {
  const [accounts, setAccounts] = useState([]);
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]); // últimos eventos recebidos
  const [tick, setTick] = useState(0); // incrementa quando algo muda -> telas recarregam
  const retry = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let ws;
    let closed = false;
    let reconnectTimer;
    let pollTimer;

    const poll = async () => {
      try {
        const list = await api.get('/api/accounts');
        setAccounts(list.map((a) => a.status));
        setTick((t) => t + 1);
      } catch { /* mantém último estado */ }
    };

    const startPolling = () => {
      if (pollTimer) return;
      poll();
      pollTimer = setInterval(poll, 5000);
    };
    const stopPolling = () => { clearInterval(pollTimer); pollTimer = null; };

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { retry.current = 0; setConnected(true); stopPolling(); };
      ws.onmessage = (m) => {
        let msg;
        try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.type === 'hello' || msg.type === 'state') {
          setAccounts(msg.accounts);
          setTick((t) => t + 1);
        }
        if (msg.type === 'events') {
          setEvents((prev) => [...msg.events.reverse(), ...prev].slice(0, 200));
          setTick((t) => t + 1);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        startPolling();
        const delay = Math.min(30000, 1000 * 2 ** retry.current++);
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => { closed = true; clearTimeout(reconnectTimer); stopPolling(); ws?.close(); };
  }, [enabled]);

  return { accounts, connected, events, tick };
}
