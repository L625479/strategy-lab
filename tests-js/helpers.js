import { runBacktest } from '../site/js/engine/backtest.js';
import { compileStrategy, emptyStrategy } from '../site/js/engine/strategy.js';

/** rows: [[o,h,l,c], ...];日期從 2025-01-06 起每天一根 */
export function makeBars(rows, start = '2025-01-06') {
  const t0 = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  const d = rows.map((_, i) => new Date(t0 + i * 86400000).toISOString().slice(0, 10));
  const col = (k) => Float64Array.from(rows, (r) => r[k]);
  return { d, n: rows.length, o: col(0), h: col(1), l: col(2), c: col(3), v: new Float64Array(rows.length) };
}

/** 隨機漫步(固定種子),給性質測試用 */
export function randomWalk(n, seed = 1, vol = 0.02, start = '2020-01-01') {
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const rows = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const open = prev * (1 + gauss() * vol * 0.3);
    const close = open * (1 + gauss() * vol);
    const wick = Math.abs(gauss()) * vol * 0.5 * close;
    rows.push([open, Math.max(open, close) + wick, Math.min(open, close) - wick, close]);
    prev = close;
  }
  return makeBars(rows, start);
}

/** 手動指定的訊號(繞過規則解析,專測回測引擎) */
export function manualSignals(n, { entryLong = [], entryShort = [], exitLong = [], exitShort = [], slPct = NaN, tpPct = NaN } = {}) {
  const flags = (idxs) => { const a = new Uint8Array(n); idxs.forEach((i) => { a[i] = 1; }); return a; };
  return {
    ind: {}, valid: new Uint8Array(n).fill(1),
    entryLong: flags(entryLong), entryShort: flags(entryShort), exitLong: flags(exitLong), exitShort: flags(exitShort),
    slPct: Number.isNaN(slPct) ? null : new Float64Array(n).fill(slPct),
    tpPct: Number.isNaN(tpPct) ? null : new Float64Array(n).fill(tpPct),
  };
}

export function strategyWith(patch = {}) {
  const s = emptyStrategy();
  s.costs = { commissionBps: 0, slippageBps: 0 };
  return { ...s, ...patch, costs: { ...s.costs, ...(patch.costs || {}) }, sizing: { ...s.sizing, ...(patch.sizing || {}) } };
}

export function run(rows, sigSpec, patch = {}, capital = 10000) {
  const bars = makeBars(rows);
  return runBacktest({ bars, signals: manualSignals(bars.n, sigSpec), strategy: strategyWith(patch), capital });
}

export function compileOrThrow(strategy) {
  const r = compileStrategy(strategy);
  if (!r.ok) throw new Error(r.errors.map((e) => `${e.field}: ${e.message}`).join('; '));
  return r.compiled;
}

/** 訊號在 idx1 收盤確認 → idx2 開盤 101.2 成交 */
export const ENTRY = [
  [100, 101, 99, 100],
  [100, 102, 99.5, 101],
  [101.2, 103, 100, 102],
];
