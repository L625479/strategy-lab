import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse } from '../site/js/engine/expr.js';
import { makeFunctions } from '../site/js/engine/indicators.js';
import { buildWeightsData, compileWeights, emptyWeightsStrategy, evaluateWeights, normalizeWeightsStrategy, rateSeries } from '../site/js/engine/weights.js';
import { runTargetWeights, runWeights } from '../site/js/engine/weightsrun.js';
import { makeBars, randomWalk } from './helpers.js';

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
const F = (a) => Float64Array.from(a);
const DAYS = (n, start = '2025-01-06') => Array.from({ length: n }, (_, i) => new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10) + i)).toISOString().slice(0, 10));

/** 一個標的、給定 開高低收 與每天的目標權重 */
function sim({ o, c, w, dates = DAYS(c.length), rate = 0, band = 0.1, maxGross = 2, allowShort = false, sideBps = 0, borrowFeePct = 0, spreadPct = 0, capital = 1000, startIdx = 0, h, l }) {
  const n = c.length;
  const asset = { name: 'A', o: F(o), h: F(h || o.map((x, i) => Math.max(x, c[i]))), l: F(l || o.map((x, i) => Math.min(x, c[i]))), c: F(c) };
  return runTargetWeights({
    dates, tradables: [asset], weights: [F(Array.isArray(w) ? w : new Array(n).fill(w))], rate: F(Array.isArray(rate) ? rate : new Array(n).fill(rate)),
    capital, startIdx, endIdx: n - 1, band, maxGross, allowShort, sideBps, borrowFeePct, spreadPct,
  });
}

// ---- 帳戶運算(手算) ----------------------------------------------------------------

test('權重 1、沒有任何成本: 第二天開盤買進,淨值跟著價格走,帶內的偏離不動', () => {
  const r = sim({ o: [100, 100, 110, 121], c: [100, 110, 121, 133.1], w: 1 });
  assert.deepEqual([...r.equity].map((x) => Math.round(x * 1e6) / 1e6), [1000, 1100, 1210, 1331]);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].idx, 1); near(r.fills[0].shares, 10); assert.equal(r.fills[0].price, 100);
  assert.deepEqual([...r.shares[0]], [0, 10, 10, 10]);
});

test('第一根 K 棒不交易(沒有前一天的訊號);起始日 > 第一根時,起始日開盤依前一天收盤的訊號成交', () => {
  const o = [100, 100, 100, 100, 100], c = [100, 100, 100, 100, 100];
  assert.equal(sim({ o, c, w: 1 }).fills[0].idx, 1);
  const r = sim({ o, c, w: 1, startIdx: 2 });
  assert.equal(r.fills[0].idx, 2);
  assert.equal(r.dates.length, 3);
});

test('閒置現金賺利息: 依前一根收盤的餘額,天數是與前一根相隔的日曆天數 ÷ 365(週末算進去)', () => {
  const dates = ['2025-01-03', '2025-01-06', '2025-01-07'];                    // 週五、週一、週二
  const r = sim({ o: [100, 100, 100], c: [100, 100, 100], w: 0, dates, rate: 0.05 });
  const e1 = 1000 * (1 + (0.05 * 3) / 365), e2 = e1 * (1 + 0.05 / 365);
  near(r.equity[1], e1); near(r.equity[2], e2);
  near(r.totals.interest, e2 - 1000);
});

test('槓桿 2 倍: 多單超過淨值的部分付 利率 + 利差,自有現金不再計息', () => {
  const r = sim({ o: [100, 100, 100, 100], c: [100, 100, 100, 100], w: 2, rate: 0.05, spreadPct: 1 });
  // 第 1 根: 開盤前先結算閒置現金利息(1 天),再用 2 倍買進
  const e1 = 1000 * (1 + 0.05 / 365);
  near(r.equity[1], e1); near(r.shares[0][1], (2 * e1) / 100);
  // 第 2 根: 前一根收盤時 多單 = 2·e1、淨值 = e1 → 融資 = e1;只付 (5% + 1%),沒有利息收入
  const e2 = e1 - e1 * (0.06 / 365);
  near(r.equity[2], e2);
  const e3 = e2 - (2 * e1 - e2) * (0.06 / 365);                               // 第 3 根: 多單仍是 2·e1(帶內沒有調整),融資 = 2·e1 − e2
  near(r.equity[3], e3);
  assert.ok(r.borrowed[1] > 0.99 && r.borrowed[1] < 1.01);
  near(r.totals.financing, (e1 - e2) + (e2 - e3), 1e-9);
});

test('放空: 借券費照空單市值收、放空所得不計息;自有現金照常賺利息', () => {
  const r = sim({ o: [100, 100, 100], c: [100, 100, 90], w: -1, allowShort: true, rate: 0.05, borrowFeePct: 3 });
  const e1 = 1000 * (1 + 0.05 / 365);                                           // 第 1 根開盤前: 閒置現金 1000 的利息
  near(r.equity[1], e1);
  near(r.shares[0][1], -e1 / 100);
  // 第 2 根: 前一根收盤 空單市值 = e1、淨值 = e1、多單 = 0 → 閒置現金 = e1 賺 5%,借券費 3% × e1
  const accrual = e1 * (0.05 / 365) - e1 * (0.03 / 365);
  near(r.accrual[2], accrual);
  near(r.equity[2], e1 + accrual + (-e1 / 100) * (90 - 100));                   // 加上空單的價差獲利
  near(r.totals.borrowFee, e1 * 0.03 / 365);
});

test('再平衡帶: 偏離「超過」帶才調整(剛好等於不動),調整一次算一筆並收成本', () => {
  // 目標 0.5。第 1 根開盤買進 5 股(現金 500)。第 2 根開盤 120 → 權重 600/1100 = 0.545(差 0.045,帶內)
  const o = [100, 100, 120, 151, 151], c = [100, 100, 120, 151, 151];
  const r = sim({ o, c, w: 0.5, sideBps: 10 });
  assert.deepEqual(r.fills.map((f) => f.idx), [1, 3], '只有第 1 根(建倉)與第 3 根(權重 0.6016 超過帶)有成交');
  near(r.fills[0].cost, 500 * 0.001);
  const eOpen3 = 500 - 0.5 + 5 * 151;                                           // 現金扣掉建倉成本後 + 5 股市值
  const newShares = (0.5 * eOpen3) / 151;
  near(r.fills[1].shares, newShares - 5);
  near(r.fills[1].cost, Math.abs(newShares - 5) * 151 * 0.001);
  assert.ok(r.fills[1].shares < 0 && Math.abs(r.fills[1].fromWeight - 0.6) < 0.01);
  // 剛好等於帶(用二進位能精確表示的數字): 目標 0.5、開盤價 300 → 權重 1500/2000 = 0.75,差 0.25 = 帶 → 不動;差一點點就動
  const exact = (o3) => sim({ o: [100, 100, 100, o3, o3], c: [100, 100, 100, o3, o3], w: 0.5, band: 0.25 });
  assert.equal(exact(300).fills.length, 1);
  assert.equal(exact(300.01).fills.length, 2);
});

test('目標權重的處理: NaN 當 0、不能放空時夾到 0、總曝險超過上限等比例縮小', () => {
  const run = (w1, w2, opts) => {
    const a = (name) => ({ name, o: F([100, 100, 100]), h: F([100, 100, 100]), l: F([100, 100, 100]), c: F([100, 100, 100]) });
    return runTargetWeights({
      dates: DAYS(3), tradables: [a('A'), a('B')], weights: [F([w1, w1, w1]), F([w2, w2, w2])], rate: F([0, 0, 0]), capital: 1000, startIdx: 0, endIdx: 2,
      band: 0.01, maxGross: 2, allowShort: false, sideBps: 0, borrowFeePct: 0, spreadPct: 0, ...opts,
    });
  };
  const w = (r) => [r.exposure[0][1], r.exposure[1][1]].map((x) => Math.round(x * 1e9) / 1e9);
  assert.deepEqual(w(run(1.5, 1.5)), [1, 1], '總曝險 3 → 縮成上限 2');
  assert.deepEqual(w(run(-1, 0.5)), [0, 0.5], '不能放空: 負的夾到 0');
  assert.deepEqual(w(run(-1, 0.5, { allowShort: true })), [-1, 0.5]);
  assert.deepEqual(w(run(NaN, 0.5)), [0, 0.5], 'NaN 當 0(空手)');
  assert.deepEqual(w(run(3, 0, { maxGross: 2.5 })), [2.5, 0]);
});

test('爆倉: 淨值 <= 0 就清空、歸零並維持到結束,不再成交', () => {
  const r = sim({ o: [100, 100, 40, 40, 40], c: [100, 100, 40, 40, 40], w: 2 });
  // 第 1 根 2 倍買進 20 股(借 1000);第 2 根開盤 40 → 淨值 = -1000 + 800 = -200 → 爆倉
  assert.equal(r.ruined, true);
  assert.deepEqual([...r.equity].slice(1), [1000, 0, 0, 0]);
  assert.equal(r.fills.length, 1);
  assert.deepEqual([...r.shares[0]], [0, 20, 0, 0, 0]);
});

test('爆倉也會在「收盤才跌破」時發生: 開盤還正常、收盤淨值 <= 0 → 當天歸零', () => {
  const r = sim({ o: [100, 100, 100, 100], c: [100, 100, 40, 40], w: 2 });
  assert.equal(r.ruined, true);
  assert.deepEqual([...r.equity].slice(1), [1000, 0, 0]);
  assert.deepEqual([...r.shares[0]], [0, 20, 0, 0]);
});

test('目標權重不是有限數(NaN、Infinity)一律當 0,不會讓帳戶出現 NaN', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r = sim({ o: [100, 100, 100], c: [100, 101, 102], w: bad, allowShort: true });
    assert.deepEqual([...r.equity], [1000, 1000, 1000]);
    assert.equal(r.fills.length, 0);
  }
});

test('訊號只用到前一天收盤: 改掉第 t 天的高低收,第 t 天開盤的成交完全不變', () => {
  const spy = randomWalk(200, 31, 0.015);
  const c = compileWeights(strat({
    indicators: [{ name: 'vol', expr: 'std(ret(close), 20)' }],
    weights: [{ series: 'px', expr: 'ifelse(close > sma(close, 30), clip(0.01 / vol, 0, 2), -0.5)' }], allowShort: true, band: 0.02,
  })).compiled;
  const run = (bars) => runWeights(c, buildWeightsData(c, data1(bars)), { capital: 5000 });
  const base = run(spy);
  let compared = 0;
  for (const t of [60, 100, 150]) {
    const h = Float64Array.from(spy.h), l = Float64Array.from(spy.l), cl = Float64Array.from(spy.c);
    cl[t] *= 1.3; h[t] = Math.max(h[t], cl[t]); l[t] = Math.min(l[t], cl[t] * 0.9);                  // 只動第 t 天的收盤與高低
    const alt = run({ ...spy, h, l, c: cl });
    const a = base.run.fills.find((f) => f.idx === t), b = alt.run.fills.find((f) => f.idx === t);
    assert.deepEqual(b, a, `第 ${t} 天開盤的成交不該受第 ${t} 天收盤影響`);
    assert.equal(alt.run.shares[0][t], base.run.shares[0][t]);
    compared++;
  }
  assert.equal(compared, 3);
  assert.ok(base.run.fills.length > 20);
});

test('帳戶恆等式(隨機行情、隨機權重、放空、利息、成本): 每天淨值變化 = 隔夜損益 + 盤中損益 + 利息收支 − 成本', () => {
  for (const seed of [1, 2, 3]) {
    const bars = randomWalk(300, seed, 0.02);
    const n = bars.n;
    let s = seed * 7919;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const w = Float64Array.from({ length: n }, () => -1 + rnd() * 3.4);
    const rate = Float64Array.from({ length: n }, () => 0.01 + rnd() * 0.05);
    const r = runTargetWeights({
      dates: bars.d, tradables: [{ name: 'A', o: bars.o, h: bars.h, l: bars.l, c: bars.c }], weights: [w], rate, capital: 10000, startIdx: 0, endIdx: n - 1,
      band: 0.03, maxGross: 2.5, allowShort: true, sideBps: 7, borrowFeePct: 3, spreadPct: 1.2,
    });
    assert.ok(r.fills.length > 30 && !r.ruined);
    for (let k = 1; k < n; k++) {
      const before = r.shares[0][k - 1], after = r.shares[0][k];
      const pnl = before * (bars.o[k] - bars.c[k - 1]) + after * (bars.c[k] - bars.o[k]);
      near(r.equity[k] - r.equity[k - 1], pnl + r.accrual[k] - r.tradeCost[k], 1e-9);
    }
    near(r.totals.costs, r.fills.reduce((a, f) => a + f.cost, 0));
  }
});

// ---- 策略、運算式與資料 ----------------------------------------------------------------

const strat = (patch = {}) => ({ ...emptyWeightsStrategy(), ...patch });
const data1 = (bars) => ({ SPY: bars });

test('編譯: 錯誤指到欄位;名稱衝突、未知序列、空運算式', () => {
  const bad = strat({
    series: [{ name: 'px', ticker: 'SPY' }, { name: 'px', ticker: '' }, { name: 'a b', ticker: 'X' }], params: [{ name: 'px_close', value: 1 }],
    indicators: [{ name: 'v', expr: 'ghost + 1' }, { name: 'w', expr: 'sma(close)' }],
    weights: [{ series: 'nope', expr: '' }, { series: 'nope', expr: '1' }], rates: { mode: 'series', series: 'zzz', constantPct: -1 }, band: 500, maxGross: 0,
  });
  const { ok, errors } = compileWeights(bad);
  assert.equal(ok, false);
  const fields = errors.map((e) => e.field);
  for (const f of ['series[1].name', 'series[2].name', 'params[0].name', 'indicators[0].expr', 'indicators[1].expr', 'weights[0].series', 'weights[0].expr', 'weights[1].series', 'rates.series', 'rates.constantPct', 'band', 'maxGross']) assert.ok(fields.includes(f), `${f} ∈ ${fields}`);
  assert.ok(compileWeights(emptyWeightsStrategy()).ok);
  assert.ok(compileWeights(strat({ maxGross: 4 })).warnings.some((w) => /融資利息/.test(w)));
});

test('匯入的資料會被清理(型別不對、過長)', () => {
  const s = normalizeWeightsStrategy({ name: 5, series: 'x', weights: [{ series: 1, expr: null }], band: 'a', allowShort: 'yes', costs: { sideBps: Infinity }, rates: { mode: 'weird' } });
  assert.equal(s.name, '我的權重策略'); assert.deepEqual(s.series, []); assert.equal(s.band, 10); assert.equal(s.allowShort, false);
  assert.equal(s.costs.sideBps, 5); assert.equal(s.rates.mode, 'constant');
});

test('求值: 序列名稱 x_close、第一個標的的簡寫 close、指標由上往下、權重的 NaN 在暖機期', () => {
  const spy = randomWalk(120, 4, 0.01), oil = randomWalk(120, 5, 0.02);
  const c = compileWeights(strat({
    series: [{ name: 'px', ticker: 'SPY' }, { name: 'oil', ticker: 'CL=F' }], params: [{ name: 'n', value: 20 }],
    indicators: [{ name: 'vol', expr: 'std(ret(close), n)' }, { name: 'trend', expr: 'oil_close > sma(oil_close, n)' }],
    weights: [{ series: 'px', expr: 'ifelse(trend, min(2, 0.01 / vol), 0)' }],
  }));
  assert.ok(c.ok, JSON.stringify(c.errors));
  const data = buildWeightsData(c.compiled, { SPY: spy, 'CL=F': oil });
  const { weights, ind } = evaluateWeights(c.compiled, data);
  assert.equal(weights.length, 1);
  assert.ok(Number.isNaN(ind.vol[10]) && Number.isFinite(ind.vol[60]));
  assert.equal(weights[0][10], 0, '暖機期: 比較式遇到 NaN 為假,走 ifelse 的 0 那一支');
  const i = 80;
  const rets = Array.from({ length: 20 }, (_, k) => spy.c[i - k] / spy.c[i - k - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / 20, sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / 19);
  near(ind.vol[i], sd);
  const oilMa = oil.c.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
  near(weights[0][i], oil.c[i] > oilMa ? Math.min(2, 0.01 / sd) : 0);
});

test('利率序列: 用「前一根收盤」的利率(序列 ÷ 100),沒有值當 0', () => {
  const spy = makeBars(Array.from({ length: 4 }, () => [100, 100, 100, 100]));
  const irx = { ...makeBars([[5, 5, 5, 5], [5, 5, 5, 5], [10, 10, 10, 10], [10, 10, 10, 10]]) };
  const c = compileWeights(strat({
    series: [{ name: 'px', ticker: 'SPY' }, { name: 'irx', ticker: '^IRX' }], weights: [{ series: 'px', expr: '0' }], rates: { mode: 'series', series: 'irx', constantPct: 0 },
  }));
  const data = buildWeightsData(c.compiled, { SPY: spy, '^IRX': irx });
  assert.deepEqual([...rateSeries(c.compiled, data)], [0.05, 0.05, 0.1, 0.1]);
  const r = runWeights(c.compiled, data, { capital: 1000 });
  const e1 = 1000 * (1 + 0.05 / 365), e2 = e1 * (1 + 0.05 / 365), e3 = e2 * (1 + 0.10 / 365);
  near(r.equity[1], e1); near(r.equity[2], e2); near(r.equity[3], e3);
  assert.equal(compileWeights(strat({ rates: { mode: 'constant', series: '', constantPct: 4 } })).ok, true);
});

test('不偷看: 把第 t 天之後的行情換掉,到第 t 天為止的淨值完全不變(權重隔天才成交)', () => {
  const spy = randomWalk(400, 9, 0.015);
  const c = compileWeights(strat({
    indicators: [{ name: 'vol', expr: 'std(ret(close), 20)' }, { name: 'sig', expr: 'close > sma(close, 50)' }],
    weights: [{ series: 'px', expr: 'ifelse(sig, clip(0.01 / vol, 0, 2), -0.5)' }], allowShort: true, rates: { mode: 'constant', series: '', constantPct: 3 },
  })).compiled;
  const run = (bars, endDate) => runWeights(c, buildWeightsData(c, data1(bars)), { capital: 5000, end: endDate });
  const full = run(spy);
  for (const t of [120, 250, 399]) {
    const o = Float64Array.from(spy.o), h = Float64Array.from(spy.h), l = Float64Array.from(spy.l), cl = Float64Array.from(spy.c);
    for (let i = t + 1; i < spy.n; i++) { o[i] = 50 + i; h[i] = 60 + i; l[i] = 40 + i; cl[i] = 55 + i; }
    const alt = run({ ...spy, o, h, l, c: cl });
    assert.deepEqual([...alt.equity.slice(0, t + 1)], [...full.equity.slice(0, t + 1)], `第 ${t} 天之前的淨值被未來的資料影響了`);
  }
  const cut = run({ ...spy, d: spy.d.slice(0, 200), o: spy.o.slice(0, 200), h: spy.h.slice(0, 200), l: spy.l.slice(0, 200), c: spy.c.slice(0, 200), v: spy.v.slice(0, 200), n: 200 });
  assert.deepEqual([...cut.equity], [...full.equity.slice(0, 200)]);
});

test('完整流程: 買進持有 1 倍的權重策略 = 第一天開盤買進持有(省去 1 根訊號延遲以外沒有差別)', () => {
  const spy = randomWalk(300, 12, 0.012);
  const c = compileWeights(strat({ weights: [{ series: 'px', expr: '1' }] })).compiled;
  const r = runWeights(c, buildWeightsData(c, data1(spy)), { capital: 1000 });
  // 第 1 根沒有訊號所以空手,第 2 根開盤買進;之後每天淨值變化 = 持股 × 價格變化
  const sh = r.run.shares[0][1];
  assert.ok(Math.abs(r.run.fills[0].toWeight - 1) < 1e-12);
  for (let k = 2; k < 300; k++) near(r.equity[k] - r.equity[k - 1], sh * (spy.c[k] - spy.c[k - 1]) + (k === 2 ? 0 : 0) - r.run.tradeCost[k] + r.run.accrual[k], 1e-6);
  assert.equal(r.account.fills, r.run.fills.length);
  assert.ok(r.account.avgGross > 0.99 && r.account.avgGross <= 1.0000001 && r.account.shareLevered === 0);
  near(r.metrics.totalReturn, r.equity[299] / 1000 - 1);
});

test('完整流程: 起始日與結束日、基準、暖機期、缺資料的提示', () => {
  const spy = randomWalk(300, 21, 0.012), qqq = randomWalk(300, 22, 0.015);
  const c = compileWeights(strat({
    series: [{ name: 'px', ticker: 'SPY' }, { name: 'q', ticker: 'QQQ' }], weights: [{ series: 'px', expr: '1' }], warmupBars: 50,
  })).compiled;
  const data = buildWeightsData(c, { SPY: spy, QQQ: qqq });
  const r = runWeights(c, data, { capital: 1000, start: spy.d[100], end: spy.d[250], benchmark: 'q' });
  assert.equal(r.dates[0], spy.d[100]); assert.equal(r.dates.at(-1), spy.d[250]);
  assert.equal(r.bench.id, 'q'); assert.equal(r.bench.equity.length, 151);
  near(r.bench.equity[150] / 1000, qqq.c[250] / qqq.o[100]);
  near(r.buyHold[150] / 1000, spy.c[250] / spy.o[100]);
  assert.equal(r.run.fills[0].idx, 100, '起始日開盤依前一天收盤的訊號買進(暖機期 50 根已過)');
  assert.throws(() => runWeights(c, data, { start: '2100-01-01' }), /沒有資料/);
  assert.throws(() => buildWeightsData(c, { SPY: spy }), /找不到 QQQ/);
});

test('規則語法的新函式: sqrt / log / exp / sign / pow / clip / ifelse / avg / ret / std / sum / cummean', async () => {
  const { evaluate } = await import('../site/js/engine/expr.js');
  const funcs = makeFunctions({ c: F([1, 2, 3]), h: F([1, 2, 3]), l: F([1, 2, 3]) });
  const env = { x: F([1, 4, 9, 16]), y: F([2, -3, 0, 5]) };
  const E = (src) => evaluate(parse(src), { env, funcs });
  assert.deepEqual([...E('sqrt(x)')], [1, 2, 3, 4]);
  assert.deepEqual([...E('sign(y)')], [1, -1, 0, 1]);
  assert.deepEqual([...E('clip(y, -1, 3)')], [2, -1, 0, 3]);
  assert.deepEqual([...E('ifelse(y > 0, x, 0 - x)')], [1, -4, -9, 16]);
  assert.deepEqual([...E('avg(x, y, 3)')], [0, 1, 2, 3].map((i) => (env.x[i] + env.y[i] + 3) / 3));
  assert.equal(E('pow(2, 3) + exp(0) + log(1)'), 9);
  const r1 = E('ret(x)');
  assert.ok(Number.isNaN(r1[0])); near(r1[1], 3); near(r1[2], 1.25); near(r1[3], 7 / 9);
  assert.deepEqual([...E('sum(x, 2)')], [NaN, 5, 13, 25]);
  assert.deepEqual([...E('cummean(x)')], [1, 2.5, 14 / 3, 7.5]);
  const sd = E('std(x, 3)');
  near(sd[2], Math.sqrt(((1 - 14 / 3) ** 2 + (4 - 14 / 3) ** 2 + (9 - 14 / 3) ** 2) / 2));
  assert.ok(Number.isNaN(sd[1]));
  assert.ok(Number.isNaN(E('ifelse(ret(x) > 0, 1, 2)')[0]) === false, '比較式遇到 NaN 為假 → 走 else');
  assert.ok(Number.isNaN(E('ifelse(ret(x), 1, 2)')[0]), '條件本身是 NaN → 結果 NaN');
  assert.ok(Number.isNaN(E('sqrt(0 - x)')[0]) && Number.isNaN(E('avg(x, ret(x))')[0]));
});
