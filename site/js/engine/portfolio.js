// 投資組合: 每個標的分配資金後各自獨立執行策略(一個標的一個「部位槽」),
// 再依日期對齊、加總成組合的權益曲線。單一標的就是權重 100% 的組合。
//
// 與「買入持有」比較: 同樣的權重與資金,在區間第一根開盤買進後不動(不再平衡)。

import { runBacktest } from './backtest.js';
import { correlationMatrix, drawdownSeries, equityMetrics, monthlyReturns, tradeStats } from './metrics.js';
import { computeSignals } from './strategy.js';

/** 第一個 date >= start 的索引(沒有則 -1) */
function firstOnOrAfter(dates, start) {
  if (!start) return dates.length ? 0 : -1;
  for (let i = 0; i < dates.length; i++) if (dates[i] >= start) return i;
  return -1;
}

/** 最後一個 date <= end 的索引(沒有則 -1) */
function lastOnOrBefore(dates, end) {
  if (!end) return dates.length - 1;
  for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= end) return i;
  return -1;
}

/** 把一條(日期, 值)序列對齊到聯集日曆: 開始前用 before,結束後沿用最後一個值 */
function alignTo(calendar, dates, values, before) {
  const out = new Float64Array(calendar.length);
  let j = 0, last = before;
  for (let i = 0; i < calendar.length; i++) {
    while (j < dates.length && dates[j] <= calendar[i]) { last = values[j]; j++; }
    out[i] = last;
  }
  return out;
}

function buyAndHold(bars, startIdx, endIdx, alloc) {
  const shares = alloc / bars.o[startIdx];
  const values = new Float64Array(endIdx - startIdx + 1);
  for (let i = startIdx; i <= endIdx; i++) values[i - startIdx] = shares * bars.c[i];
  return values;
}

/**
 * @param {{ assets: {id:string,name?:string,bars:object,weight:number}[], compiled: object,
 *           capital: number, start?: string, end?: string, benchmark?: {id:string,bars:object},
 *           externalSignals?: Record<string, object> }} args
 *   externalSignals: 標的 id → 已經算好的訊號(Python 策略由伺服器算出來,見 pystrategy.js);有給就不再用規則語法計算
 */
export function runPortfolio({ assets, compiled, capital, start = null, end = null, benchmark = null, externalSignals = null }) {
  if (!(capital > 0)) throw new Error('初始資金必須大於 0');
  const active = assets.filter((a) => a.weight > 0);
  const totalWeight = active.reduce((s, a) => s + a.weight, 0);
  if (!active.length || !(totalWeight > 0)) throw new Error('請至少選擇一個標的,且權重必須大於 0');

  const warnings = [];
  const sleeves = [];
  for (const a of active) {
    const startIdx = firstOnOrAfter(a.bars.d, start), endIdx = lastOnOrBefore(a.bars.d, end);
    if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) {
      warnings.push(`${a.id} 在所選期間內沒有資料,已略過(其權重不會重新分配)`);
      continue;
    }
    if (start && a.bars.d[startIdx] > start && (Date.parse(a.bars.d[startIdx]) - Date.parse(start)) / 86400000 > 7) {
      warnings.push(`${a.id} 的資料從 ${a.bars.d[startIdx]} 才開始,在那之前這份資金以現金持有`);
    }
    const weight = a.weight / totalWeight, alloc = capital * weight;
    if (compiled.python && !externalSignals?.[a.id]) throw new Error(`缺少 ${a.id} 的 Python 策略訊號(要先由伺服器執行 Python 策略)`);
    const signals = externalSignals?.[a.id] || computeSignals(compiled, a.bars);
    const bt = runBacktest({ bars: a.bars, signals, strategy: compiled.strategy, capital: alloc, startIdx, endIdx });
    sleeves.push({
      id: a.id, name: a.name || a.id, weight, alloc, bars: a.bars, signals, startIdx, endIdx, bt,
      bh: buyAndHold(a.bars, startIdx, endIdx, alloc),
    });
  }
  if (!sleeves.length) throw new Error('所選期間內所有標的都沒有資料');

  const calendar = [...new Set(sleeves.flatMap((s) => s.bt.dates))].sort();
  const equity = new Float64Array(calendar.length), buyHold = new Float64Array(calendar.length);
  let exposure = 0;
  for (const s of sleeves) {
    s.equity = alignTo(calendar, s.bt.dates, s.bt.equity, s.alloc);
    s.buyHold = alignTo(calendar, s.bt.dates, s.bh, s.alloc);
    for (let i = 0; i < calendar.length; i++) { equity[i] += s.equity[i]; buyHold[i] += s.buyHold[i]; }
    s.metrics = equityMetrics(calendar, s.equity, s.alloc);
    s.buyHoldMetrics = equityMetrics(calendar, s.buyHold, s.alloc);
    s.tradeStats = tradeStats(s.bt.trades);
    s.contribution = (s.equity[s.equity.length - 1] - s.alloc) / capital;
    s.exposure = s.bt.inPos.reduce((a, b) => a + b, 0) / s.bt.inPos.length;
    exposure += s.weight * s.exposure;
  }

  let bench = null;
  if (benchmark) {
    const startIdx = firstOnOrAfter(benchmark.bars.d, start), endIdx = lastOnOrBefore(benchmark.bars.d, end);
    if (startIdx >= 0 && endIdx >= startIdx) {
      const vals = buyAndHold(benchmark.bars, startIdx, endIdx, capital);
      bench = { id: benchmark.id, equity: alignTo(calendar, benchmark.bars.d.slice(startIdx, endIdx + 1), vals, capital) };
      bench.metrics = equityMetrics(calendar, bench.equity, capital);
    } else {
      warnings.push(`基準 ${benchmark.id} 在所選期間內沒有資料`);
    }
  }

  const trades = sleeves.flatMap((s) => s.bt.trades.map((t) => ({ ...t, symbol: s.id }))).sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));
  const openPositions = sleeves.filter((s) => s.bt.openPosition).map((s) => ({ symbol: s.id, ...s.bt.openPosition }));

  return {
    capital, calendar, equity, buyHold, bench, sleeves, trades, openPositions, warnings,
    metrics: equityMetrics(calendar, equity, capital),
    buyHoldMetrics: equityMetrics(calendar, buyHold, capital),
    tradeStats: tradeStats(trades),
    drawdown: drawdownSeries(equity, capital),
    buyHoldDrawdown: drawdownSeries(buyHold, capital),
    monthly: monthlyReturns(calendar, equity, capital),
    exposure,
    correlation: sleeves.length > 1 ? { ids: sleeves.map((s) => s.id), matrix: correlationMatrix(sleeves.map((s) => s.buyHold)) } : null,
  };
}
