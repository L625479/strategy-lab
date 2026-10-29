import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  correlationMatrix, drawdownSeries, equityMetrics, monthlyReturns, tradeStats, yearsBetween,
} from '../site/js/engine/metrics.js';
import { runPortfolio } from '../site/js/engine/portfolio.js';
import { TEMPLATES, compileStrategy } from '../site/js/engine/strategy.js';
import { makeBars, randomWalk } from './helpers.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const F = (xs) => Float64Array.from(xs);
const compiledOf = (id) => compileStrategy(TEMPLATES.find((t) => t.id === id).strategy).compiled;

test('權益指標: 手算對照', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04'];
  const m = equityMetrics(dates, F([110, 99, 121, 121]), 100);
  near(m.totalReturn, 0.21);
  near(m.maxDrawdown, 99 / 110 - 1);
  const rets = [99 / 110 - 1, 121 / 99 - 1, 0];
  const mean = rets.reduce((a, b) => a + b) / 3, sd = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / 2);
  const years = 3 / 365.25, ppy = 3 / years;
  near(m.ppy, ppy, 1e-6);
  near(m.sharpe, (mean / sd) * Math.sqrt(ppy), 1e-9);
  near(m.vol, sd * Math.sqrt(ppy), 1e-9);
  near(m.cagr, 1.21 ** (1 / years) - 1, 1e-6);
  near(m.bestDay, 121 / 99 - 1); near(m.worstDay, 99 / 110 - 1);
  assert.equal(m.maxDdDays, 1);
  assert.equal(equityMetrics(['2025-01-01'], F([100]), 100).maxDrawdown, 0); // 資料太少不會當掉
});

test('回撤序列: 第一天下跌也算相對起始資金', () => {
  const dd = drawdownSeries(F([95, 90, 100, 120, 108]), 100);
  assert.deepEqual(Array.from(dd).map((x) => +x.toFixed(4)), [-0.05, -0.1, 0, 0, -0.1]);
});

test('最長水下天數: 未恢復的回撤算到結束', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-03', '2025-01-04', '2025-01-05'];
  assert.equal(equityMetrics(dates, F([100, 90, 95, 105, 100]), 100).maxDdDays, 2);   // 01-01 高點 → 01-04 恢復前
  assert.equal(equityMetrics(dates, F([100, 110, 100, 95, 90]), 100).maxDdDays, 3);   // 01-02 高點 → 到結束都沒恢復
});

test('年數: 以日曆日計', () => { near(yearsBetween('2024-01-01', '2025-01-01'), 366 / 365.25); });

test('交易統計', () => {
  const T = (pnl, retPct, dir = 'long', reason = 'signal', bars = 5) => ({ pnl, retPct, dir, reason, bars });
  const s = tradeStats([T(100, 10), T(-50, -5, 'short', 'stop_loss'), T(200, 20), T(-50, -5, 'long', 'stop_loss')]);
  assert.equal(s.n, 4); near(s.winRate, 0.5); near(s.profitFactor, 3); near(s.avgWin, 150); near(s.avgLoss, -50);
  near(s.expectancy, 50); near(s.avgRetPct, 5); assert.equal(s.longs, 3); assert.equal(s.shorts, 1);
  assert.deepEqual(s.byReason, { signal: 2, stop_loss: 2 });
  assert.equal(tradeStats([T(10, 1)]).profitFactor, Infinity);
  assert.ok(Number.isNaN(tradeStats([]).winRate));
});

test('月報酬: 以月底權益,第一個月以起始資金為基準,含不完整月份', () => {
  const dates = ['2025-01-30', '2025-01-31', '2025-02-03', '2025-02-28', '2025-03-03'];
  const m = monthlyReturns(dates, F([101, 102, 103, 112.2, 110]), 100);
  assert.deepEqual(m.map((x) => [x.year, x.month, +x.ret.toFixed(4)]), [[2025, 1, 0.02], [2025, 2, 0.1], [2025, 3, -0.0196]]);
});

test('相關係數: 自己對自己 = 1,完全反向 = -1', () => {
  const a = F([100, 102, 101, 105, 103, 108]), b = a.map((x) => 200 - x);
  const c = correlationMatrix([a, a, F([100, 98, 99.5, 95.2, 97.4, 92.6])]);
  near(c[0][1], 1); near(c[0][0], 1); assert.ok(c[0][2] < -0.99);
  assert.ok(b.length === a.length);
});

// ---- 投資組合 ---------------------------------------------------------------

const upBars = (n, start, base = 100, step = 1) => makeBars(Array.from({ length: n }, (_, i) => [base + i * step, base + i * step + 1, base + i * step - 1, base + i * step + 0.5]), start);

test('單一標的: 買入持有基準 = 第一根開盤買進、持有到最後', () => {
  const bars = upBars(40, '2025-01-06');
  const r = runPortfolio({ assets: [{ id: 'A', bars, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 10000 });
  const shares = 10000 / bars.o[0];
  near(r.buyHold[0], shares * bars.c[0]); near(r.buyHold.at(-1), shares * bars.c[39]);
  assert.equal(r.calendar.length, 40); assert.equal(r.sleeves.length, 1);
  assert.equal(r.trades.length, 0); assert.equal(r.openPositions.length, 1); // 買入持有:一直持有中
});

test('投資組合: 權重正規化、資金依權重分配、權益 = 各標的加總', () => {
  const a = upBars(40, '2025-01-06', 100), b = upBars(40, '2025-01-06', 50, 0.5);
  const r = runPortfolio({ assets: [{ id: 'A', bars: a, weight: 3 }, { id: 'B', bars: b, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 8000 });
  near(r.sleeves[0].weight, 0.75); near(r.sleeves[1].alloc, 2000);
  for (let i = 0; i < r.calendar.length; i++) {
    near(r.equity[i], r.sleeves[0].equity[i] + r.sleeves[1].equity[i], 1e-6);
    near(r.buyHold[i], r.sleeves[0].buyHold[i] + r.sleeves[1].buyHold[i], 1e-6);
  }
  near(r.sleeves.reduce((s, x) => s + x.contribution, 0), r.metrics.totalReturn, 1e-9); // 貢獻度加總 = 組合報酬
});

test('不同交易日曆: 聯集日曆,缺的日子沿用前值;資料晚開始的標的先持有現金', () => {
  const a = upBars(10, '2025-01-06');                      // 01-06 ~ 01-15
  const b = upBars(10, '2025-01-10', 50);                  // 01-10 ~ 01-19
  const r = runPortfolio({ assets: [{ id: 'A', bars: a, weight: 1 }, { id: 'B', bars: b, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 2000 });
  assert.equal(r.calendar[0], '2025-01-06'); assert.equal(r.calendar.at(-1), '2025-01-19'); assert.equal(r.calendar.length, 14);
  const [sa, sb] = r.sleeves;
  assert.equal(sb.equity[0], 1000);                         // B 還沒開始: 現金
  assert.equal(sb.equity[3], 1000);                         // 01-09 仍沒資料
  assert.equal(sa.equity.at(-1), sa.equity[9]);             // A 在 01-15 後沒有新資料: 沿用最後一個值
  assert.equal(r.warnings.length, 0);                       // 沒指定起點,不算「資料晚開始」
  // 差幾天的起點落差(週末、假日)不提醒;晚開始超過 7 天才提醒
  const near4 = runPortfolio({ assets: [{ id: 'A', bars: a, weight: 1 }, { id: 'B', bars: b, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 2000, start: '2025-01-06' });
  assert.equal(near4.warnings.length, 0);
  const late = upBars(10, '2025-01-20', 50);
  const withLate = runPortfolio({ assets: [{ id: 'A', bars: a, weight: 1 }, { id: 'B', bars: late, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 2000, start: '2025-01-06' });
  assert.ok(withLate.warnings.some((w) => w.includes('B') && w.includes('2025-01-20')));
});

test('日期範圍: start/end 之前的資料只用來暖機,不計入績效', () => {
  const bars = randomWalk(800, 4, 0.015, '2020-01-01');
  const full = runPortfolio({ assets: [{ id: 'X', bars, weight: 1 }], compiled: compiledOf('sma_cross'), capital: 10000 });
  const part = runPortfolio({ assets: [{ id: 'X', bars, weight: 1 }], compiled: compiledOf('sma_cross'), capital: 10000, start: bars.d[400], end: bars.d[700] });
  assert.equal(part.calendar[0], bars.d[400]); assert.equal(part.calendar.at(-1), bars.d[700]);
  assert.equal(part.equity[0], 10000);
  assert.ok(full.calendar.length === 800 && part.calendar.length === 301);
  // 起點之前的資料有拿來算指標: 區間第一天就可能已經有訊號/部位,不必等暖機
  const firstTrade = part.trades[0] || part.openPositions[0];
  assert.ok(firstTrade);
});

test('沒有資料的標的被略過並警告;全部都沒有則報錯', () => {
  const a = upBars(40, '2025-01-06'), b = upBars(10, '2024-01-01');
  const r = runPortfolio({ assets: [{ id: 'A', bars: a, weight: 1 }, { id: 'B', bars: b, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 1000, start: '2025-01-06' });
  assert.equal(r.sleeves.length, 1); assert.ok(r.warnings.some((w) => w.includes('B')));
  assert.throws(() => runPortfolio({ assets: [{ id: 'B', bars: b, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 1000, start: '2025-01-06' }), /沒有資料/);
  assert.throws(() => runPortfolio({ assets: [], compiled: compiledOf('buy_hold'), capital: 1000 }), /至少/);
  assert.throws(() => runPortfolio({ assets: [{ id: 'A', bars: a, weight: 0 }], compiled: compiledOf('buy_hold'), capital: 1000 }), /權重/);
});

test('基準標的: 全部資金買入持有,對齊到組合日曆', () => {
  const a = upBars(40, '2025-01-06'), spy = upBars(50, '2025-01-01', 400, 2);
  const r = runPortfolio({ assets: [{ id: 'A', bars: a, weight: 1 }], compiled: compiledOf('buy_hold'), capital: 5000, start: '2025-01-06', benchmark: { id: 'SPY', bars: spy } });
  assert.equal(r.bench.id, 'SPY'); assert.equal(r.bench.equity.length, r.calendar.length);
  const i0 = spy.d.indexOf('2025-01-06');
  near(r.bench.equity[0], (5000 / spy.o[i0]) * spy.c[i0], 1e-6);
});

test('投資組合用多標的跑真實策略: 交易帶 symbol、依進場日排序、統計一致', () => {
  const assets = ['A', 'B', 'C'].map((id, k) => ({ id, bars: randomWalk(900, 20 + k, 0.02), weight: 1 }));
  const r = runPortfolio({ assets, compiled: compiledOf('ema_rsi'), capital: 30000 });
  assert.ok(r.trades.length > 3);
  assert.ok(r.trades.every((t) => ['A', 'B', 'C'].includes(t.symbol)));
  assert.ok(r.trades.every((t, i, a) => i === 0 || a[i - 1].entryDate <= t.entryDate));
  assert.equal(r.tradeStats.n, r.sleeves.reduce((s, x) => s + x.tradeStats.n, 0));
  assert.equal(r.correlation.ids.length, 3); near(r.correlation.matrix[1][1], 1);
  assert.ok(r.exposure >= 0 && r.exposure <= 1);
  near(r.sleeves.reduce((s, x) => s + x.contribution, 0), r.metrics.totalReturn, 1e-9);
});
