import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers, CrosshairMode } from 'lightweight-charts';

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// Candlestick + volume + indicadores da estratégia + pontos de BUY/SELL
// + linhas de stop-loss / take-profit da posição aberta.
export function CandleChart({ candles, indicators = {}, markers = [], position, show = { volume: true, indicators: true, markers: true, levels: true }, height = 360 }) {
  const el = useRef(null);

  useEffect(() => {
    if (!el.current || !candles?.length) return undefined;
    const up = css('--color-good') || '#22b35e';
    const down = css('--color-bad') || '#e25555';
    const chart = createChart(el.current, {
      height,
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--color-ink-3'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css('--color-border') } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: {
        locale: 'pt-BR',
        priceFormatter: (p) => p.toLocaleString('pt-BR', { maximumFractionDigits: 2 }),
        timeFormatter: (t) => new Date(t * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
      },
    });

    const main = chart.addSeries(CandlestickSeries, {
      upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false,
    });
    main.setData(candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })));

    if (show.volume) {
      const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(candles.map((c) => ({ time: c.t, value: c.v, color: c.c >= c.o ? `${up}55` : `${down}55` })));
    }

    if (show.indicators) {
      const lines = [
        ['emaFast', css('--color-series-1'), 'EMA rápida'],
        ['emaSlow', css('--color-series-2'), 'EMA lenta'],
        ['emaTrend', css('--color-series-3'), 'EMA tendência'],
      ];
      for (const [k, color, title] of lines) {
        if (!indicators[k]?.length) continue;
        const s = chart.addSeries(LineSeries, { color, lineWidth: 2, title, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
        s.setData(indicators[k].map((p) => ({ time: p.t, value: p.v })));
      }
    }

    if (show.markers && markers.length) {
      const first = candles[0].t;
      const tf = candles.length > 1 ? candles[1].t - candles[0].t : 900;
      createSeriesMarkers(main, markers.filter((m) => m.t >= first).map((m) => ({
        time: Math.floor(m.t / tf) * tf,
        position: m.side === 'BUY' ? 'belowBar' : 'aboveBar',
        color: m.side === 'BUY' ? up : down,
        shape: m.side === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: m.side === 'BUY' ? 'BUY' : m.purpose === 'STOP_LOSS' ? 'SELL (stop)' : m.purpose === 'TAKE_PROFIT' ? 'SELL (alvo)' : 'SELL',
      })).sort((a, b) => a.time - b.time));
    }

    if (show.levels && position) {
      main.createPriceLine({ price: position.average_price, color: css('--color-ink-2'), lineWidth: 1, lineStyle: 2, title: 'Preço médio' });
      if (position.stop_price) main.createPriceLine({ price: position.stop_price, color: down, lineWidth: 1, lineStyle: 1, title: 'Stop-loss' });
      if (position.take_profit_price) main.createPriceLine({ price: position.take_profit_price, color: up, lineWidth: 1, lineStyle: 1, title: 'Take-profit' });
    }

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, indicators, markers, position, show.volume, show.indicators, show.markers, show.levels, height]);

  return <div ref={el} className="w-full" style={{ height }} />;
}
