// 圖表。使用 TradingView Lightweight Charts(vendor/ 底下的 standalone 版,全域變數 LightweightCharts)。
// 規格依 dataviz 規範: 線 2px、格線細且不搶眼、滑鼠十字線 + 一個提示框列出所有序列、顏色從 CSS 變數讀取(亮暗模式各自挑選)。

import { cssVar, h } from './dom.js';

const LW = () => window.LightweightCharts;

export function readTheme() {
  const v = (n) => cssVar(n);
  return {
    surface: v('--surface'), ink: v('--ink'), ink2: v('--ink-2'), muted: v('--muted'), grid: v('--grid'), axis: v('--axis'),
    s: Array.from({ length: 8 }, (_, i) => v(`--s${i + 1}`)),
    good: v('--good'), bad: v('--bad'), mid: v('--mid'), polePos: v('--pole-pos'), poleNeg: v('--pole-neg'),
    font: getComputedStyle(document.body).fontFamily,
  };
}

/** '#rrggbb' → rgba(...)。色票全是 6 位 hex。 */
export function withAlpha(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

export function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : 2 });
}

function baseOptions(t, { logo = false, timeVisible = true } = {}) {
  return {
    autoSize: true,
    layout: { background: { type: 'solid', color: t.surface }, textColor: t.ink2, fontFamily: t.font, fontSize: 12, attributionLogo: logo },
    grid: { vertLines: { visible: false }, horzLines: { color: t.grid } },
    rightPriceScale: { borderColor: t.axis, scaleMargins: { top: 0.1, bottom: 0.08 } },
    timeScale: { borderColor: t.axis, timeVisible: false, rightOffsetPixels: 28, visible: timeVisible },
    crosshair: {
      mode: 0,
      vertLine: { color: t.muted, width: 1, style: 0, labelBackgroundColor: t.ink2 },
      horzLine: { visible: false, labelVisible: false },
    },
    handleScale: { axisPressedMouseMove: { time: true, price: false } },
  };
}

/** 一個提示框列出十字線所在位置所有序列的值: 值為主(粗體),名稱為輔;用線段色塊而不是方塊當圖例 */
function attachTooltip(container, chart, rows, titleOf) {
  const tip = h('div', { class: 'tip', role: 'presentation' });
  container.append(tip);
  chart.subscribeCrosshairMove((p) => {
    if (!p.point || !p.time || p.point.x < 0 || p.point.y < 0) { tip.style.display = 'none'; return; }
    const lines = [];
    for (const r of rows) {
      const d = p.seriesData.get(r.series);
      if (!d) continue;
      lines.push(h('div', { class: 'r' },
        h('span', { class: 'k' }, h('i', { style: { borderColor: r.color } }), r.label),
        h('b', null, r.format(d.value ?? d.close, d))));
    }
    if (!lines.length) { tip.style.display = 'none'; return; }
    tip.replaceChildren(h('div', { class: 't' }, titleOf(p.time)), ...lines);
    tip.style.display = 'block';
    const w = tip.offsetWidth, W = container.clientWidth;
    tip.style.left = `${p.point.x + 16 + w > W ? Math.max(4, p.point.x - w - 16) : p.point.x + 16}px`;
    tip.style.top = '8px';
  });
  return tip;
}

/** 讓兩張圖共用同一段時間範圍(滑動/縮放同步) */
export function linkCharts(a, b) {
  let busy = false;
  const sync = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
    if (busy || !r) return;
    busy = true;
    to.timeScale().setVisibleLogicalRange(r);
    busy = false;
  });
  sync(a, b); sync(b, a);
}

/**
 * 權益曲線: 策略(主角,品牌藍)、買入持有(灰,當對照)、額外基準(橘)。
 * lines = [{key,label,color,values:Float64Array}],dates 與 values 等長。
 */
export function equityChart(container, { dates, lines, log = false }, t = readTheme()) {
  const chart = LW().createChart(container, { ...baseOptions(t, { logo: true }), localization: { priceFormatter: compact } });
  const rows = lines.map((l) => {
    const series = chart.addSeries(LW().LineSeries, {
      color: l.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 4,
      crosshairMarkerBorderColor: t.surface, crosshairMarkerBorderWidth: 2,
    });
    series.setData(dates.map((d, i) => ({ time: d, value: l.values[i] })));
    return { series, label: l.label, color: l.color, format: compact };
  });
  chart.priceScale('right').applyOptions({ mode: log ? 1 : 0 });
  chart.timeScale().fitContent();
  attachTooltip(container, chart, rows, (time) => String(time));
  return { chart, setLog: (on) => chart.priceScale('right').applyOptions({ mode: on ? 1 : 0 }) };
}

/** 回撤: 策略用淡淡的色塊(10%),買入持有用灰線。數值已是 %(<= 0)。 */
export function drawdownChart(container, { dates, strategy, buyHold }, t = readTheme()) {
  const fmt = (v) => `${v.toFixed(1)}%`;
  const chart = LW().createChart(container, { ...baseOptions(t), localization: { priceFormatter: fmt } });
  chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.05 } });
  const area = chart.addSeries(LW().AreaSeries, {
    lineColor: t.s[0], lineWidth: 2, topColor: withAlpha(t.s[0], 0.10), bottomColor: withAlpha(t.s[0], 0.10),
    invertFilledArea: true, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4,
  });
  area.setData(dates.map((d, i) => ({ time: d, value: strategy[i] * 100 })));
  const line = chart.addSeries(LW().LineSeries, { color: t.muted, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4 });
  line.setData(dates.map((d, i) => ({ time: d, value: buyHold[i] * 100 })));
  chart.timeScale().fitContent();
  attachTooltip(container, chart, [
    { series: area, label: '策略回撤', color: t.s[0], format: fmt },
    { series: line, label: '買入持有回撤', color: t.muted, format: fmt },
  ], (time) => String(time));
  return { chart };
}

/** 曝險(倍數): 總曝險(多單 + 空單的絕對值,占淨值)與淨曝險;虛線是 1 倍。 */
export function exposureChart(container, { dates, gross, net }, t = readTheme()) {
  const fmt = (v) => `${v.toFixed(2)}×`;
  const chart = LW().createChart(container, { ...baseOptions(t), localization: { priceFormatter: fmt } });
  const area = chart.addSeries(LW().AreaSeries, {
    lineColor: t.s[0], lineWidth: 2, topColor: withAlpha(t.s[0], 0.14), bottomColor: withAlpha(t.s[0], 0.02), priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4,
  });
  area.setData(dates.map((d, i) => ({ time: d, value: gross[i] })));
  area.createPriceLine({ price: 1, color: t.muted, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '1×' });
  const rows = [{ series: area, label: '總曝險', color: t.s[0], format: fmt }];
  if (net.some((v, i) => Math.abs(v - gross[i]) > 1e-9)) {
    const line = chart.addSeries(LW().LineSeries, { color: t.muted, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 4 });
    line.setData(dates.map((d, i) => ({ time: d, value: net[i] })));
    rows.push({ series: line, label: '淨曝險', color: t.muted, format: fmt });
  }
  chart.timeScale().fitContent();
  attachTooltip(container, chart, rows, (time) => String(time));
  return { chart };
}

const REASON = { signal: '訊號', stop_loss: '止損', take_profit: '止盈' };
export const reasonLabel = (r) => REASON[r] || r;

/**
 * 價格圖(單一標的): K 線 + 進出場標記 + 指標。
 * indicators = [{name, values(完整長度), panel: 0|1, color}],0 = 疊在價格上,1 = 另開下方窗格(震盪類指標)。
 */
export function priceChart(container, { bars, startIdx, endIdx, trades, indicators }, t = readTheme()) {
  const lw = LW();
  const chart = lw.createChart(container, { ...baseOptions(t, { logo: true }), localization: { priceFormatter: (v) => v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 }) } });
  // K 線用中性色(空心 = 上漲,實心 = 下跌),把顏色留給指標線與進出場標記(獲利藍、虧損紅)
  const candles = chart.addSeries(lw.CandlestickSeries, {
    upColor: t.surface, downColor: t.ink2, borderUpColor: t.ink2, borderDownColor: t.ink2,
    wickUpColor: t.ink2, wickDownColor: t.ink2, borderVisible: true, priceLineVisible: false,
  });
  const data = [];
  for (let i = startIdx; i <= endIdx; i++) data.push({ time: bars.d[i], open: bars.o[i], high: bars.h[i], low: bars.l[i], close: bars.c[i] });
  candles.setData(data);

  // 標記文字會互相蓋住: 只在交易很少時才標出場報酬,進場只用箭頭(完整資料在交易明細表與提示框)
  const showText = trades.length <= 12;
  const markers = [];
  for (const tr of trades) {
    const long = tr.dir === 'long', win = tr.pnl >= 0;
    markers.push({ time: tr.entryDate, position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: t.ink2, text: '' });
    markers.push({ time: tr.exitDate, position: long ? 'aboveBar' : 'belowBar', shape: long ? 'arrowDown' : 'arrowUp', color: win ? t.polePos : t.poleNeg,
      text: showText ? `${tr.retPct >= 0 ? '+' : ''}${tr.retPct.toFixed(1)}%` : '' });
  }
  markers.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  lw.createSeriesMarkers(candles, markers);

  const rows = [{ series: candles, label: '收盤', color: t.muted, format: (v) => v.toLocaleString('en-US', { maximumFractionDigits: 4 }) }];
  const handles = [];
  for (const ind of indicators) {
    const series = chart.addSeries(lw.LineSeries, { color: ind.color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerRadius: 3 }, ind.panel);
    const pts = [];
    for (let i = startIdx; i <= endIdx; i++) if (Number.isFinite(ind.values[i])) pts.push({ time: bars.d[i], value: ind.values[i] });
    series.setData(pts);
    rows.push({ series, label: ind.name, color: ind.color, format: (v) => v.toLocaleString('en-US', { maximumFractionDigits: 4 }) });
    handles.push({ name: ind.name, series, color: ind.color });
  }
  if (indicators.some((i) => i.panel === 1)) {
    const panes = chart.panes();
    if (panes[1]) panes[1].setStretchFactor(0.35);
  }
  chart.timeScale().fitContent();
  attachTooltip(container, chart, rows, (time) => String(time));
  return { chart, indicators: handles };
}
