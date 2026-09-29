import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api.js';

// Busca um endpoint e recarrega quando `refreshKey` muda (tempo real),
// no máximo a cada `minIntervalMs` para não sobrecarregar a API.
export function useApi(path, refreshKey, { minIntervalMs = 3000, enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const last = useRef(0);
  const timer = useRef(null);

  const load = useCallback(async () => {
    if (!path || !enabled) return;
    last.current = Date.now();
    try {
      const d = await api.get(path);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [path, enabled]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  useEffect(() => {
    if (refreshKey === undefined) return undefined;
    const wait = Math.max(0, minIntervalMs - (Date.now() - last.current));
    clearTimeout(timer.current);
    timer.current = setTimeout(load, wait);
    return () => clearTimeout(timer.current);
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error, loading, reload: load };
}
