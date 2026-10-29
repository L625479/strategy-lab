import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runBacktest } from '../site/js/engine/backtest.js';
import { computeSignals } from '../site/js/engine/strategy.js';
import { ENTRY, compileOrThrow, makeBars, manualSignals, randomWalk, run, strategyWith } from './helpers.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} 應約等於 ${b}`);
const SHARES = 10000 / 101; // 訊號在 idx1 收盤(101),用當時權益 100% 計算股數

test('止盈: 訊號隔天開盤成交,止盈價 = 成交價 + 10%', () => {
  const r = run([...ENTRY, [102, 112, 101, 111]], { entryLong: [1], slPct: 5, tpPct: 10 });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryDate, '2025-01-08');            // idx2,不是訊號當天
  near(t.entryPrice, 101.2); near(t.exitPrice, 111.32);
  assert.equal(t.reason, 'take_profit'); assert.equal(t.dir, 'long');
  near(t.pnl, SHARES * (111.32 - 101.2), 1e-6);
  near(r.equity.at(-1), 10000 + t.pnl, 1e-6);          // 全部平倉後權益 = 本金 + 損益
});

test('止損', () => {
  const r = run([...ENTRY, [102, 103, 95, 96]], { entryLong: [1], slPct: 5, tpPct: 10 });
  near(r.trades[0].exitPrice, 101.2 * 0.95); assert.equal(r.trades[0].reason, 'stop_loss');
  assert.ok(r.trades[0].pnl < 0);
});

test('同一根同時碰到止損與止盈 → 取止損(保守)', () => {
  const r = run([...ENTRY, [102, 115, 90, 100]], { entryLong: [1], slPct: 5, tpPct: 10 });
  assert.equal(r.trades[0].reason, 'stop_loss');
});

test('開盤跳空越過止損 → 以開盤價成交,不是止損價', () => {
  const r = run([...ENTRY, [90, 91, 89, 90]], { entryLong: [1], slPct: 5, tpPct: 10 });
  near(r.trades[0].exitPrice, 90); assert.equal(r.trades[0].reason, 'stop_loss');
});

test('開盤跳空越過止盈 → 以開盤價成交(價格改善)', () => {
  const r = run([...ENTRY, [115, 116, 114, 115]], { entryLong: [1], slPct: 5, tpPct: 10 });
  near(r.trades[0].exitPrice, 115); assert.equal(r.trades[0].reason, 'take_profit');
});

test('進場那一根當天就可能被止損', () => {
  const r = run([[100, 101, 99, 100], [100, 102, 99.5, 101], [101.2, 103, 90, 95]], { entryLong: [1], slPct: 5 });
  assert.equal(r.trades.length, 1); assert.equal(r.trades[0].bars, 0);
});

test('訊號出場: 收盤確認、下一根開盤成交', () => {
  const r = run([...ENTRY, [102, 103, 101, 102], [100.5, 101, 99, 100]], { entryLong: [1], exitLong: [3] });
  near(r.trades[0].exitPrice, 100.5); assert.equal(r.trades[0].reason, 'signal');
  assert.equal(r.trades[0].exitDate, '2025-01-10');
});

test('成本: 滑價對進出場都不利,手續費兩邊都收,權益守恆', () => {
  const costs = { commissionBps: 10, slippageBps: 20 };
  const r = run([...ENTRY, [102, 103, 101, 102], [100.5, 101, 99, 100]], { entryLong: [1], exitLong: [3] }, { costs });
  const t = r.trades[0];
  near(t.entryPrice, 101.2 * 1.002); near(t.exitPrice, 100.5 * 0.998);
  const feeIn = t.shares * t.entryPrice * 0.001, feeOut = t.shares * t.exitPrice * 0.001;
  near(t.pnl, t.shares * (t.exitPrice - t.entryPrice) - feeIn - feeOut, 1e-6);
  near(r.equity.at(-1), 10000 + t.pnl, 1e-6);
});

test('做空: 進場用下跌方向的止盈止損,損益方向相反', () => {
  const rows = [[100, 101, 99, 100], [100, 100.5, 98, 99], [98.8, 99, 88, 90]];
  const r = run(rows, { entryShort: [1], slPct: 5, tpPct: 10 }, { allowShort: true });
  const t = r.trades[0];
  assert.equal(t.dir, 'short'); near(t.entryPrice, 98.8);
  near(t.exitPrice, 98.8 * 0.9); assert.equal(t.reason, 'take_profit');
  assert.ok(t.pnl > 0);
});

test('不允許做空時忽略做空訊號', () => {
  const r = run([...ENTRY, [102, 103, 101, 102]], { entryShort: [1] }, { allowShort: false });
  assert.equal(r.trades.length, 0); assert.equal(r.openPosition, null);
});

test('部位大小: 淨值的 50% → 股數減半', () => {
  const r = run([...ENTRY, [102, 103, 101, 102]], { entryLong: [1] }, { sizing: { pctEquity: 50 } });
  near(r.openPosition.shares, (10000 * 0.5) / 101);
});

test('回測結束時仍持有: 不強制平倉,未實現損益計入權益', () => {
  const r = run([...ENTRY, [102, 104, 101, 103]], { entryLong: [1] });
  assert.equal(r.trades.length, 0);
  assert.equal(r.openPosition.dir, 'long');
  near(r.equity.at(-1), 10000 + SHARES * (103 - 101.2), 1e-6);
  near(r.openPosition.unrealized, SHARES * (103 - 101.2), 1e-6);
});

test('最後一根的訊號不會下單(沒有下一根可以成交)', () => {
  const r = run(ENTRY, { entryLong: [2] });
  assert.equal(r.trades.length, 0); assert.equal(r.openPosition, null);
});

test('持有中不會重複進場,出場後才能再進場', () => {
  const rows = Array.from({ length: 8 }, (_, i) => [100 + i, 101 + i, 99 + i, 100 + i]);
  const r = run(rows, { entryLong: [0, 1, 2, 3, 4, 5], exitLong: [3] });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryDate, '2025-01-07'); // idx1 開盤(idx0 的訊號)
  assert.equal(r.openPosition.entryIdx, 5);          // idx4 出場後 idx4 的訊號 → idx5 開盤再進
});

test('startIdx: 起點之前的資料不交易,權益從起點開始', () => {
  const bars = makeBars([...ENTRY, [102, 112, 101, 111], [111, 112, 110, 111]]);
  const sig = manualSignals(bars.n, { entryLong: [1, 3] });
  const r = runBacktest({ bars, signals: sig, strategy: strategyWith(), capital: 10000, startIdx: 3 });
  assert.equal(r.equity.length, 2); assert.equal(r.dates[0], bars.d[3]);
  assert.equal(r.trades.length, 0); // idx1 的訊號早於起點,被略過;idx3 是倒數第二根 → idx4 才成交 → 持有中
  assert.equal(r.openPosition.entryIdx, 4);
});

test('輸入檢查', () => {
  const bars = makeBars(ENTRY), signals = manualSignals(3);
  assert.throws(() => runBacktest({ bars, signals, strategy: strategyWith(), capital: 0 }), /資金/);
  assert.throws(() => runBacktest({ bars, signals, strategy: strategyWith(), capital: 1, startIdx: 3, endIdx: 2 }), /沒有資料/);
});

// ---- 性質測試(不依賴手算) ----------------------------------------------------

const emaStrategy = () => compileOrThrow(strategyWith({
  params: [{ name: 'f', value: 8 }, { name: 's', value: 21 }],
  indicators: [{ name: 'a', expr: 'ema(close, f)' }, { name: 'b', expr: 'ema(close, s)' }],
  entry: { long: 'cross_above(a, b)', short: '' }, exit: { long: 'cross_below(a, b)', short: '' },
  stopLoss: { mode: 'pct', pct: 6, atrN: 14, atrMult: 2, expr: '' }, takeProfit: { mode: 'pct', pct: 12, atrN: 14, atrMult: 4, expr: '' },
  warmupBars: 30, costs: { commissionBps: 5, slippageBps: 5 },
}));

test('沒有未來函數: 截掉後面的資料,前面已平倉的交易完全相同', () => {
  const compiled = emaStrategy();
  const bars = randomWalk(900, 7, 0.02);
  const full = runBacktest({ bars, signals: computeSignals(compiled, bars), strategy: compiled.strategy, capital: 10000 });
  assert.ok(full.trades.length >= 5, '測試資料要有足夠的交易才有意義');
  for (const cut of [300, 500, 700]) {
    const sub = { ...bars, d: bars.d.slice(0, cut), o: bars.o.slice(0, cut), h: bars.h.slice(0, cut), l: bars.l.slice(0, cut), c: bars.c.slice(0, cut), v: bars.v.slice(0, cut), n: cut };
    const part = runBacktest({ bars: sub, signals: computeSignals(compiled, sub), strategy: compiled.strategy, capital: 10000 });
    const key = (t) => [t.entryIdx, t.exitIdx, t.entryPrice, t.exitPrice, t.reason].join('|');
    const expected = full.trades.filter((t) => t.exitIdx < cut - 1).map(key);
    assert.deepEqual(part.trades.filter((t) => t.exitIdx < cut - 1).map(key), expected, `cut=${cut}`);
    assert.deepEqual(Array.from(part.equity.slice(0, cut - 1)), Array.from(full.equity.slice(0, cut - 1)), `權益 cut=${cut}`);
  }
});

test('權益守恆: 全部平倉的時點,權益 = 本金 + 已實現損益', () => {
  const compiled = emaStrategy();
  const bars = randomWalk(900, 11, 0.02);
  const r = runBacktest({ bars, signals: computeSignals(compiled, bars), strategy: compiled.strategy, capital: 10000 });
  let pnl = 0;
  const flat = new Set();
  for (const t of r.trades) { pnl += t.pnl; flat.add(t.exitIdx); }
  let realized = 0;
  const byExit = new Map(r.trades.map((t) => [t.exitIdx, t]));
  for (let i = 0; i < r.equity.length; i++) {
    const t = byExit.get(i);
    if (t) realized += t.pnl;
    if (!r.inPos[i]) near(r.equity[i], 10000 + realized, 1e-6);
  }
  assert.ok(r.trades.length > 0 && Math.abs(pnl) > 0);
});
