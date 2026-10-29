import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  compileDayRule, compileGrid, emptyDayRule, emptyGrid, evaluateRules, expandRules, frontier, makeTickerContext, normalizeGrid, panelFromBars,
  passes, pickCandidates, ruleToGrid, splitSegments, standardGrid, summarize, traceRule,
} from '../site/js/engine/daytrade.js';
import { parse } from '../site/js/engine/expr.js';
import { panelFromNpz, readNpz } from '../site/js/engine/npz.js';
import { makeBars, randomWalk } from './helpers.js';

const asBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const npz = (name) => asBuffer(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** 一檔標的、rows = [[o,h,l,c], ...] 的面板 */
const panelOf = (rows, aux = {}) => panelFromBars([{ id: 'X', bars: makeBars(rows) }], aux);
const ALL = (panel, minTrades = 1) => [{ name: 'all', rows: panel.dates.map(() => true), minTrades }];

/** 只改幾個欄位的單一規則;預設沒有指標,所以每天都可以交易 */
const rule = (patch = {}) => ({ ...emptyDayRule(), indicators: [], setup: 'true', ...patch });

function run(panel, patch, { variants = ['cons'], key, thresholds, minTrades = 1 } = {}) {
  const c = compileDayRule(rule(patch));
  assert.ok(c.ok, JSON.stringify(c.errors));
  const k = key || expandRules(c.compiled)[0].key;
  const trace = (variant = 'cons') => traceRule(panel, c.compiled, k, { variant });
  const out = evaluateRules(panel, c.compiled, { segments: ALL(panel, minTrades), variants, thresholds, median: true });
  return { stats: out.rules[0].stats, trace, compiled: c.compiled, key: k };
}

const near = (a, b, tol = 1e-12) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// ---- 成交規則 ---------------------------------------------------------------------

test('市價進場、收盤出場: 做多與放空,成本單邊 5 bps 各算一次', () => {
  const panel = panelOf([[100, 102, 99, 101], [100, 102, 97, 98]]);
  const long = run(panel, { side: 'long' });
  const t = long.trace();
  near(t.net[0], 101 / 100 - 1 - 0.001); near(t.net[1], 98 / 100 - 1 - 0.001);
  const short = run(panel, { side: 'short' }).trace();
  near(short.net[0], -(101 / 100 - 1) - 0.001); near(short.net[1], -(98 / 100 - 1) - 0.001);
});

test('停利(開盤市價進場): 最高價要穿過停利價 10 bps 才算,成交在停利價不是最高價', () => {
  const T = 100 * (1 + 0.02), need = T * 1.001;
  const panel = panelOf([[100, need - 0.001, 99, 100.5], [100, need + 0.001, 99, 100.5], [100, 105, 99, 100.5]]);
  const { trace } = run(panel, { exit: { takeProfit: '0.02' } });
  const t = trace();
  assert.deepEqual([...t.dayIdx], [0, 1, 2]);
  near(t.net[0], 100.5 / 100 - 1 - 0.001);        // 差一點沒穿價 → 收盤出場
  near(t.net[1], 0.02 - 0.001);                    // 穿價 → 停利價出場
  near(t.net[2], 0.02 - 0.001);                    // 最高價 105 也只賺到 2%
});

test('放空的停利在下方,最低價要穿過 10 bps', () => {
  const T = 100 * (1 - 0.02), need = T * 0.999;
  const panel = panelOf([[100, 101, need + 0.001, 99.5], [100, 101, need - 0.001, 99.5]]);
  const t = run(panel, { side: 'short', exit: { takeProfit: '0.02' } }).trace();
  near(t.net[0], -(99.5 / 100 - 1) - 0.001);
  near(t.net[1], 0.02 - 0.001);
});

test('限價進場: 最低價要穿過限價 10 bps 才成交,成交在限價(不是最低價)', () => {
  const E = 100 * (1 - 0.01), need = E * (1 - 0.001);
  const panel = panelOf([[100, 101, need + 0.001, 100], [100, 101, need, 100], [100, 101, 90, 100]]);
  const { trace } = run(panel, { entry: { limit: '0.01' } });
  const t = trace();
  assert.deepEqual([...t.dayIdx], [1, 2], '第 0 天只是碰到邊緣,沒穿價,不成交');
  near(t.net[0], 100 / E - 1 - 0.001); near(t.net[1], 100 / E - 1 - 0.001);
});

test('限價做空: 往上掛,最高價穿過才成交', () => {
  const E = 100 * 1.01, need = E * 1.001;
  const panel = panelOf([[100, need - 0.001, 99, 100], [100, need + 0.001, 99, 100]]);
  const t = run(panel, { side: 'short', entry: { limit: '0.01' } }).trace();
  assert.deepEqual([...t.dayIdx], [1]);
  near(t.net[0], -(100 / E - 1) - 0.001);
});

test('限價進場 + 停利: 保守算法要收盤越過停利價,樂觀算法最高價碰到就算(最高價可能在成交之前)', () => {
  // 開 100、限價 99、停利價 99 × 1.02 = 100.98。第 0 天最高價 101.5 穿過停利,但收盤 100.5 還沒到;第 1 天收盤 101 越過
  const panel = panelOf([[100, 101.5, 98, 100.5], [100, 101.5, 98, 101]]);
  const r = run(panel, { entry: { limit: '0.01' }, exit: { takeProfit: '0.02' } }, { variants: ['cons', 'opt'] });
  const cons = r.trace('cons'), opt = r.trace('opt');
  near(cons.net[0], 100.5 / 99 - 1 - 0.001);
  near(cons.net[1], 0.02 - 0.001);
  near(opt.net[0], 0.02 - 0.001);
  near(opt.net[1], 0.02 - 0.001);
  assert.ok(r.stats.opt.all.mean > r.stats.cons.all.mean);
});

test('沒有限價進場時,樂觀與保守完全相同(統計物件共用)', () => {
  const panel = panelOf([[100, 101.5, 98, 100.5], [100, 103, 98, 101]]);
  const r = run(panel, { exit: { takeProfit: '0.02' } }, { variants: ['cons', 'opt'] });
  assert.deepEqual(r.stats.opt.all, r.stats.cons.all);
});

test('淨報酬剛好是 0 不算贏;勝率、均賺、均賠、中位數', () => {
  // 成本 0: 淨報酬依序 +10%、0、-5%、-5%
  const panel = panelOf([[100, 111, 99, 110], [100, 101, 99, 100], [100, 101, 94, 95], [100, 101, 94, 95]]);
  const { stats } = run(panel, { costBps: 0 });
  const s = stats.cons.all;
  assert.equal(s.n, 4);
  assert.equal(s.win, 0.25);
  near(s.mean, (0.1 + 0 - 0.05 - 0.05) / 4);
  near(s.avgWin, 0.1); near(s.avgLoss, (0 - 0.05 - 0.05) / 3);       // 0 歸在「沒贏」那一邊,和使用者的 stats() 一樣
  near(s.median, -0.025);                                              // 偶數筆: 中間兩個的平均 (0 與 -0.05)
});

test('個股達標門檻: 平均報酬「剛好等於」門檻算達標(>=),勝率要「大於」', () => {
  // 一檔、一筆: 2 → 3 = +50%,成本 0
  const panel = panelOf([[2, 3.5, 1.9, 3]]);
  const th = { winThreshold: 0.5, meanThreshold: 0.5 };
  const { stats } = run(panel, { costBps: 0 }, { thresholds: th });
  assert.equal(stats.cons.all.stockPass, 1);
  const tight = run(panel, { costBps: 0 }, { thresholds: { winThreshold: 1, meanThreshold: 0.5 } }).stats.cons.all;
  assert.equal(tight.stockPass, 0, '勝率 100% 不大於 100%');
});

test('限價距離或停利幅度是 NaN 或負數的日子不成交', () => {
  const panel = panelOf([[100, 102, 90, 101], [100, 102, 90, 101]]);
  assert.equal(run(panel, { entry: { limit: '-0.01' } }).trace().net.length, 0);
  assert.equal(run(panel, { entry: { limit: '0 / 0' } }).trace().net.length, 0);
  assert.equal(run(panel, { exit: { takeProfit: '-0.01' } }).trace().net.length, 0);
});

// ---- 資料品質 ---------------------------------------------------------------------

test('資料品質: 一字線、缺值、非正價、高低價矛盾超過 0.5% 的日子不交易;輕微矛盾修正後照常交易', () => {
  const rows = [
    [100, 101, 99, 100],        // 0 正常
    [100, 100, 100, 100],       // 1 一字線 → 不交易
    [100, 99.3, 99, 100],       // 2 最高價比開收低 0.7% → 壞資料
    [100, 99.6, 99.5, 100],     // 3 最高價低 0.4%: 修成 100 後照常交易
    [100, 101, 99.3, 100],      // 4 最低價比開收高 … 這裡 low 99.3 < 100,正常
    [100, 101, 100.7, 100],     // 5 最低價比開收高 0.7% → 壞資料
    [100, 101, 0, 100],         // 6 非正價 → 壞資料
    [NaN, NaN, NaN, NaN],       // 7 缺值
    [100, 101, 99, 101],        // 8 正常
  ];
  const t = run(panelOf(rows), {}).trace();
  assert.deepEqual([...t.dayIdx], [0, 3, 4, 8]);
});

test('資料品質只看「當天的 K 棒」: 它是資料過濾,不是交易條件', () => {
  const panel = panelOf([[100, 101, 99, 100], [100, 100, 100, 100], [100, 101, 99, 100]]);
  const c = compileDayRule(rule());
  const ctx = makeTickerContext(c.compiled, panel, 0);
  assert.deepEqual([...ctx.ok], [1, 0, 1]);
});

// ---- 開盤決策框架 -----------------------------------------------------------------

test('框架: open 是今天的開盤價,high/low/close/volume/hl2 都是前一日的值', () => {
  const rows = [[10, 12, 9, 11], [20, 22, 19, 21], [30, 32, 29, 31], [40, 42, 39, 41]];
  const panel = panelOf(rows);
  const ctx = makeTickerContext(compileDayRule(rule()).compiled, panel, 0);
  const ev = (src) => [...ctx.evalSeries(parse(src))];
  assert.deepEqual(ev('open'), [10, 20, 30, 40]);
  assert.deepEqual(ev('close'), [NaN, 11, 21, 31]);
  assert.deepEqual(ev('high'), [NaN, 12, 22, 32]);
  assert.deepEqual(ev('low'), [NaN, 9, 19, 29]);
  assert.deepEqual(ev('hl2'), [NaN, 10.5, 20.5, 30.5]);
  assert.deepEqual(ev('hlc3'), [NaN, (12 + 9 + 11) / 3, (22 + 19 + 21) / 3, (32 + 29 + 31) / 3]);
  assert.deepEqual(ev('volume'), [NaN, 0, 0, 0]);
  assert.deepEqual(ev('open / close - 1'), [NaN, 20 / 11 - 1, 30 / 21 - 1, 40 / 31 - 1], '跳空 = 今天開盤 / 昨天收盤 - 1');
  assert.deepEqual(ev('close[1]'), [NaN, NaN, 11, 21]);
});

test('框架: 指標只看到昨天以前;sma(tr(), n) 在第 n + 2 根才有值(要有前一日收盤)', () => {
  const rows = Array.from({ length: 10 }, (_, i) => [100 + i, 102 + i, 98 + i, 101 + i]);
  const t = run(panelOf(rows), { indicators: [{ name: 'atrp', expr: 'sma(tr(), 3) / close' }] }).trace();
  assert.equal(t.dayIdx[0], 4);
  assert.equal(t.net.length, 6);
});

test('不偷看: 條件在第 t 天的值只取決於 open[t] 和 t-1 以前的資料(把 t 起的高低收與之後的一切換成亂數,結果不變)', () => {
  const bars = randomWalk(420, 7, 0.02);
  const exprs = [
    'open / close - 1 <= -atrp', 'rsi(close, 2) < 10', 'close > sma(close, 200)', 'close / close[5] - 1 <= -0.1',
    'close < close[1] and close[1] < close[2]', 'close > highest(high, 20)', 'hl2 > open', 'crossover(close, sma(close, 10))',
    'macd(close, 12, 26) > 0', 'open > bb_upper(close, 20, 2)', 'atr(14) / close > 0.02', 'stdev(close, 10) > change(close, 3)',
  ].map((src) => [src, parse(src)]);
  const base = { indicators: [{ name: 'atrp', expr: 'sma(tr(), 14) / close' }] };
  const evalAll = (b) => {
    const p = panelFromBars([{ id: 'X', bars: b }]);
    const ctx = makeTickerContext(compileDayRule(rule(base)).compiled, p, 0);
    return exprs.map(([, ast]) => ctx.evalSeries(ast));
  };
  const ref = evalAll(bars);
  let s = 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return 50 + (s / 4294967296) * 100; };
  for (const t of [30, 120, 250, 419]) {
    const o = Float64Array.from(bars.o), h = Float64Array.from(bars.h), l = Float64Array.from(bars.l), c = Float64Array.from(bars.c);
    for (let i = t; i < bars.n; i++) { h[i] = rnd(); l[i] = rnd(); c[i] = rnd(); if (i > t) o[i] = rnd(); }
    const got = evalAll({ ...bars, o, h, l, c });
    exprs.forEach(([src], e) => {
      const a = ref[e][t], b = got[e][t];
      assert.ok(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)), `${src} 在第 ${t} 天偷看了當天或之後的資料: ${a} vs ${b}`);
    });
  }
  // 反過來確認這個測試有效: 動到「前一天」就會改變結果
  const c2 = Float64Array.from(bars.c); c2[249] = 999;
  assert.notEqual(evalAll({ ...bars, c: c2 })[2][250], ref[2][250]);
});

test('外部序列(例如 ^VIX): 用前一日的收盤,所以尖峰出現的「隔天」才會觸發', () => {
  const rows = Array.from({ length: 5 }, () => [100, 101, 99, 100]);
  const vix = { d: makeBars(rows).d, c: Float64Array.from([12, 40, 12, 12, 12]) };
  const panel = panelOf(rows, { '^VIX': vix });
  const t = run(panel, { setup: 'vix > 30', aux: [{ name: 'vix', ticker: '^VIX' }] }).trace();
  assert.deepEqual([...t.dayIdx], [2]);
  const none = run(panelOf(rows), { setup: 'vix > 30', aux: [{ name: 'vix', ticker: '^VIX' }] }).trace();
  assert.equal(none.net.length, 0, '面板沒有這個外部序列 → 條件不成立,不會亂交易');
});

// ---- 統計與時段 -------------------------------------------------------------------

test('時段: 以日期切開發集與 holdout,兩段互不重疊,各自的個股門檻', () => {
  const bars = randomWalk(300, 3, 0.02);
  const panel = panelFromBars([{ id: 'X', bars }]);
  const split = bars.d[200];
  const segs = splitSegments(panel, split, { devMinTrades: 30, holdoutMinTrades: 8 });
  assert.deepEqual(segs.map((s) => s.minTrades), [30, 8]);
  assert.equal(segs[0].rows.filter(Boolean).length, 200);
  assert.ok(segs[0].rows.every((x, i) => x !== segs[1].rows[i]));
  const c = compileDayRule(rule());
  const out = evaluateRules(panel, c.compiled, { segments: segs, variants: ['cons'] }).rules[0].stats.cons;
  const all = evaluateRules(panel, c.compiled, { segments: ALL(panel), variants: ['cons'] }).rules[0].stats.cons.all;
  assert.equal(out.dev.n + out.holdout.n, all.n);
});

test('只跑開發集時,holdout 的任何資料都不會被算進去(也不會被看見)', () => {
  const bars = randomWalk(300, 5, 0.02);
  const panel = panelFromBars([{ id: 'X', bars }]);
  const dev = splitSegments(panel, bars.d[200]).slice(0, 1);
  const c = compileDayRule(rule());
  const a = evaluateRules(panel, c.compiled, { segments: dev, variants: ['cons'] }).rules[0].stats.cons;
  assert.deepEqual(Object.keys(a), ['dev']);
  // 把 holdout 的行情換成亂數,開發集結果完全不變
  const o = Float64Array.from(bars.o), h = Float64Array.from(bars.h), l = Float64Array.from(bars.l), c2 = Float64Array.from(bars.c);
  for (let i = 200; i < bars.n; i++) { o[i] = 10 + i; h[i] = 12 + i; l[i] = 9 + i; c2[i] = 11 + i; }
  const b = evaluateRules(panelFromBars([{ id: 'X', bars: { ...bars, o, h, l, c: c2 } }]), c.compiled, { segments: dev, variants: ['cons'] }).rules[0].stats.cons;
  assert.deepEqual(a.dev, b.dev);
});

test('traceRule 與 evaluateRules 對同一條規則給出相同的筆數與平均', () => {
  const panel = panelFromBars([{ id: 'A', bars: randomWalk(400, 11, 0.02) }, { id: 'B', bars: randomWalk(400, 12, 0.03) }]);
  const r = run(panel, { setup: 'open / close - 1 <= -0.005', entry: { limit: '0.005' }, exit: { takeProfit: '0.01' } }, { variants: ['cons', 'opt', 'cost2x'] });
  for (const v of ['cons', 'opt', 'cost2x']) {
    const t = r.trace(v), s = r.stats[v].all;
    assert.equal(t.net.length, s.n, v);
    near(t.net.reduce((a, b) => a + b, 0) / t.net.length, s.mean, 1e-12);
    assert.equal(new Set(t.tickerIdx).size > 1, true);
  }
  assert.ok(r.stats.cost2x.all.mean < r.stats.cons.all.mean);
});

// ---- 網格與驗證 -------------------------------------------------------------------

test('標準網格: 588 條,順序與名稱和使用者的 grid() / name() 相同', () => {
  const c = compileGrid(standardGrid());
  assert.ok(c.ok, JSON.stringify(c.errors));
  const rules = expandRules(c.compiled);
  assert.equal(rules.length, 588);
  assert.equal(rules[0].key, 'long|none|open|close');
  assert.equal(rules[1].key, 'long|none|open|tp0.5atr');
  assert.equal(rules[7].key, 'long|none|lim0.5atr|close');
  assert.equal(rules[419].key, 'long|atr>=4%|lim3atr|tp3%');
  assert.equal(rules[420].key, 'short|none|open|close');
  assert.equal(rules.at(-1).key, 'short|rsi2>90|lim3atr|tp3%');
  assert.equal(new Set(rules.map((r) => r.key)).size, 588);
});

test('單一規則就是只有一格的網格', () => {
  const g = ruleToGrid({ ...emptyDayRule(), side: 'short', setup: 'open > close', entry: { limit: '0.01' }, exit: { takeProfit: '0.02' } });
  const rules = expandRules(compileGrid(g).compiled);
  assert.deepEqual(rules.map((r) => r.key), ['short|setup|limit|tp']);
  assert.deepEqual(expandRules(compileDayRule(emptyDayRule()).compiled).map((r) => r.key), ['long|setup|open|close']);
});

test('驗證: 錯誤指到欄位,訊息說得出哪裡錯', () => {
  const bad = { ...emptyGrid(), indicators: [{ name: 'a b', expr: 'sma(close)' }, { name: 'x', expr: 'nope + 1' }],
    setups: [{ side: 'long', name: 's', expr: '' }, { side: 'long', name: 's', expr: 'close >' }],
    entries: [{ name: 'e1', expr: '' }, { name: 'e2', expr: '' }], exits: [{ name: 'x|y', expr: '1 +' }], costBps: -1, bufferBps: 5000,
    aux: [{ name: 'vix', ticker: '' }, { name: 'close', ticker: '^X' }] };
  const { ok, errors } = compileGrid(bad);
  assert.equal(ok, false);
  const fields = errors.map((e) => e.field);
  for (const f of ['indicators[0].name', 'indicators[0].expr', 'indicators[1].expr', 'setups[0].expr', 'setups[1].name', 'setups[1].expr', 'entries',
    'exits[0].name', 'exits[0].expr', 'costBps', 'bufferBps', 'aux[0].ticker', 'aux[1].name']) assert.ok(fields.includes(f), `${f} ∈ ${fields}`);
});

test('驗證: 規則總數上限、空網格、未知名稱', () => {
  const many = { ...emptyGrid(), setups: Array.from({ length: 60 }, (_, i) => ({ side: 'long', name: `s${i}`, expr: 'true' })),
    entries: Array.from({ length: 30 }, (_, i) => ({ name: `e${i}`, expr: `${i + 1} * atrp` })), exits: Array.from({ length: 30 }, (_, i) => ({ name: `x${i}`, expr: `${i + 1} * atrp` })) };
  assert.ok(compileGrid(many).errors.some((e) => /超過上限/.test(e.message)));
  assert.ok(compileGrid({ ...emptyGrid(), setups: [] }).errors.some((e) => e.field === 'setups'));
  assert.ok(compileGrid({ ...emptyGrid(), setups: [{ side: 'long', name: 'a', expr: 'close > ghost' }] }).errors[0].message.includes('ghost'));
  assert.ok(compileDayRule(emptyDayRule()).ok);
});

test('匯入的網格會被清理: 型別不對的欄位、過長的清單', () => {
  const g = normalizeGrid({ name: 42, setups: [{ side: 'weird', name: 1, expr: null }, ...Array.from({ length: 100 }, () => ({}))], costBps: 'x', aux: 'no', entries: 'no' });
  assert.equal(g.setups.length, 60);
  assert.equal(g.setups[0].side, 'long');
  assert.equal(g.costBps, 5);
  assert.deepEqual(g.aux, []);
  assert.equal(g.name, '我的網格');
});

// ---- 選擇與驗收 -------------------------------------------------------------------

const S = (win, mean, elig = 1, stockPass = 0) => ({ n: 100, days: 50, win, mean, median: 0, avgWin: 0, avgLoss: 0, dayMean: 0, elig, stockPass });
const R = (key, s) => ({ key, stats: { cons: { dev: s } } });
const get = (r) => r.stats.cons.dev;

test('驗收: D1 勝率 > 80%、D2 平均 ≥ 1%、D3 > 50% 個股達標(邊界)', () => {
  assert.deepEqual(passes(S(0.8, 0.01, 1, 0.5)), { D1: false, D2: true, D3: false });
  assert.deepEqual(passes(S(0.81, 0.0099, 1, 0.51)), { D1: true, D2: false, D3: true });
});

test('候選: 有全過的取平均最高;否則取最接近的 a(勝率過)、b(平均過)、c(兩者都接近)', () => {
  const rows = [R('p1', S(0.9, 0.02, 1, 0.6)), R('p2', S(0.85, 0.03, 1, 0.7)), R('low', S(0.5, 0.0, 1, 0))];
  assert.deepEqual(pickCandidates(rows, get), { pass: 'p2' });
  const near = [R('a1', S(0.82, 0.002)), R('a2', S(0.81, 0.004)), R('b1', S(0.6, 0.012)), R('b2', S(0.7, 0.011)), R('c1', S(0.79, 0.009)), R('thin', S(0.95, 0.05, 0.4))];
  assert.deepEqual(pickCandidates(near, get), { c: 'c1', a: 'a2', b: 'b2' });       // thin 的個股交易數不足,不列入
  assert.deepEqual(pickCandidates([R('thin', S(0.9, 0.05, 0.4))], get), {});
});

test('可行邊界與統計: 只看多數個股有足夠交易數的規則', () => {
  const rows = [R('x', S(0.52, 0.004)), R('y', S(0.66, -0.001)), R('z', S(0.9, 0.05, 0.3))];
  const f = frontier(rows, get);
  assert.equal(f.eligible, 2);
  assert.deepEqual(f.byWin.map((x) => [x.threshold, x.key]), [[0.5, 'x'], [0.55, 'y'], [0.6, 'y'], [0.65, 'y']]);
  assert.deepEqual(f.byMean.map((x) => [x.threshold, x.key]), [[0, 'x'], [0.001, 'x'], [0.0025, 'x']]);
  assert.deepEqual(summarize(rows, get), { total: 3, D1: 1, D2: 1, D1D2: 1, D3: 0, all: 0 });
});

// ---- 面板與 .npz ------------------------------------------------------------------

test('面板對齊: 日期取聯集、缺的日子是 NaN,外部序列用前值填補', () => {
  const a = makeBars([[1, 2, 0.5, 1.5], [2, 3, 1.5, 2.5], [3, 4, 2.5, 3.5]], '2025-01-06');
  const b = makeBars([[10, 11, 9, 10.5], [20, 21, 19, 20.5]], '2025-01-07');
  const vix = { d: ['2025-01-06', '2025-01-08'], c: Float64Array.from([15, 30]) };
  const p = panelFromBars([{ id: 'A', bars: a }, { id: 'B', bars: b }], { '^VIX': vix });
  assert.deepEqual(p.dates, ['2025-01-06', '2025-01-07', '2025-01-08']);
  assert.deepEqual([...p.o[1]], [NaN, 10, 20]);
  assert.deepEqual([...p.aux['^VIX']], [15, 15, 30]);
});

test('.npz: 不壓縮的 np.savez、float64 + datetime64[ns]、韓文代號都能讀', async () => {
  const stored = await panelFromNpz(npz('npz_stored.npz'));
  assert.deepEqual(stored.tickers, ['AAA', 'BBB', '한글']);
  assert.deepEqual(stored.dates, ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']);
  assert.deepEqual([...stored.o[0]], [10, 11, 12, 13]);
  assert.ok(Number.isNaN(stored.o[1][3]));
  assert.deepEqual([...stored.c[2]], [30.5, 31.5, 32.5, 33.5]);
  assert.deepEqual([...stored.aux['^VIX']], [15, 16, 17, 40]);
  const f8 = await panelFromNpz(npz('npz_f8_ns.npz'));
  assert.deepEqual(f8.dates, stored.dates);
  assert.ok(f8.o[0] instanceof Float32Array);
  assert.deepEqual(f8.aux, {});
  const raw = await readNpz(npz('npz_f8_ns.npz'));
  assert.equal(raw.Open.dtype, '<f8'); assert.deepEqual(raw.Open.shape, [4, 3]);
});

test('.npz: 壞檔案給得出看得懂的錯誤', async () => {
  await assert.rejects(panelFromNpz(new ArrayBuffer(10)), /npz/);
  await assert.rejects(panelFromNpz(asBuffer(Buffer.from('這不是 zip 檔,只是一段很長的文字'.repeat(10)))), /npz/);
  await assert.rejects(panelFromNpz(npz('npz_missing.npz')), /缺少陣列: Open、High、Low、Close/);
  await assert.rejects(panelFromNpz(npz('npz_badshape.npz')), /形狀/);
  await assert.rejects(panelFromNpz(npz('npz_fortran.npz')), /Fortran/);
  const truncated = npz('npz_stored.npz').slice(0, 800);
  await assert.rejects(panelFromNpz(truncated), /npz/);
});

test('面板日曆: 股票與 24/7 的加密貨幣混在一起,週末被剔除(否則股票的 14 日平均永遠算不出來)', () => {
  const weekday = (i) => { const d = new Date(Date.UTC(2024, 0, 1 + i)); return d.getUTCDay() !== 0 && d.getUTCDay() !== 6; };
  const mk = (days) => { const rows = days.map((_, i) => [100 + i, 102 + i, 98 + i, 101 + i]); return { d: days, n: days.length, o: Float64Array.from(rows, (r) => r[0]), h: Float64Array.from(rows, (r) => r[1]), l: Float64Array.from(rows, (r) => r[2]), c: Float64Array.from(rows, (r) => r[3]), v: new Float64Array(days.length) }; };
  const trading = Array.from({ length: 70 }, (_, i) => i).filter(weekday).map((i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
  const every = Array.from({ length: Date.parse(trading.at(-1)) / 86400000 - Date.UTC(2024, 0, 1) / 86400000 + 1 }, (_, i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10));
  const panel = panelFromBars([{ id: 'A', bars: mk(trading) }, { id: 'B', bars: mk(trading) }, { id: 'C', bars: mk(trading) }, { id: 'BTC', bars: mk(every) }]);
  assert.deepEqual(panel.dates, trading);
  assert.deepEqual(panel.dropped, { BTC: every.length - trading.length });
  assert.ok(panel.o[0].every((x) => !Number.isNaN(x)), '股票在日曆上沒有 NaN');
  const t = run(panel, { indicators: [{ name: 'atrp', expr: 'sma(tr(), 14) / close' }] }).trace();
  assert.ok(t.net.length > 100, `每檔都有交易(${t.net.length})`);
  assert.equal(new Set(t.tickerIdx).size, 4);
});

test('面板日曆: 不同標的上市時間不同、期間不重疊,也不會被交集掉', () => {
  const mk = (start, n) => { const d = Array.from({ length: n }, (_, i) => new Date(Date.UTC(2024, 0, start + i)).toISOString().slice(0, 10)); const c = Float64Array.from(d, (_, i) => 100 + i); return { d, n, o: c, h: c.map((x) => x + 1), l: c.map((x) => x - 1), c, v: new Float64Array(n) }; };
  const panel = panelFromBars([{ id: 'OLD', bars: mk(1, 10) }, { id: 'NEW', bars: mk(20, 10) }]);
  assert.equal(panel.dates.length, 20);
  assert.deepEqual(panel.dropped, {});
  assert.ok(Number.isNaN(panel.o[1][0]) && !Number.isNaN(panel.o[1][19]));
});
