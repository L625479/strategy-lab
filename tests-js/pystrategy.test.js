// Python 策略的資料模型與訊號轉換(不需要 Python): 策略結構、編譯驗證、回應轉成訊號、警告文字、組合回測要求有訊號。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runPortfolio } from '../site/js/engine/portfolio.js';
import { pythonWarnings, signalsFromPython } from '../site/js/engine/pystrategy.js';
import { TEMPLATES, compileStrategy, computeSignals, decodeShare, emptyStrategy, encodeShare, normalizeStrategy } from '../site/js/engine/strategy.js';
import { randomWalk } from './helpers.js';

const bars = randomWalk(120, 9, 0.02, '2023-01-02');
const n = bars.c.length;
const zeros = () => Array(n).fill(0);
const resp = (over = {}) => ({ ok: true, signals: { entry_long: zeros(), exit_long: zeros(), entry_short: zeros(), exit_short: zeros(), stop_loss_pct: null, take_profit_pct: null, ...over.signals }, valid: Array(n).fill(1), ...over, ...(over.signals ? { signals: { entry_long: zeros(), exit_long: zeros(), entry_short: zeros(), exit_short: zeros(), stop_loss_pct: null, take_profit_pct: null, ...over.signals } } : {}) });

test('策略結構: 預設是規則策略;python 設定被整理成合法的形狀(型別不對的丟掉、數量與長度有上限)', () => {
  const s = emptyStrategy();
  assert.equal(s.source, 'rules'); assert.deepEqual(s.python, { id: '', params: {}, checkLookahead: true });
  const p = normalizeStrategy({ source: 'python', python: { id: 'my_strat', params: { n: 5, flag: true, label: 'x'.repeat(500), bad: null, obj: {}, arr: [1], nan: NaN, inf: Infinity, '': 1, ['k'.repeat(41)]: 1 }, checkLookahead: false } });
  assert.equal(p.source, 'python'); assert.equal(p.python.id, 'my_strat'); assert.equal(p.python.checkLookahead, false);
  assert.deepEqual(Object.keys(p.python.params), ['n', 'flag', 'label']);
  assert.equal(p.python.params.label.length, 200);
  assert.equal(normalizeStrategy({ source: 'bogus' }).source, 'rules');
  assert.equal(normalizeStrategy({ source: 'python', python: { id: 'a' } }).python.checkLookahead, true, '沒有寫就是開啟(偷看未來的檢查預設開啟)');
  assert.equal(normalizeStrategy({ python: 'x' }).python.id, '');
  const many = normalizeStrategy({ python: { params: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`p${i}`, i])) } });
  assert.equal(Object.keys(many.python.params).length, 30);
  assert.equal(normalizeStrategy({ python: { id: 'a'.repeat(100) } }).python.id.length, 60);
});

test('舊的策略檔與範本(沒有 source / python 欄位)照常載入,仍是規則策略', () => {
  const { source, python, ...legacy } = emptyStrategy();
  const n1 = normalizeStrategy(legacy);
  assert.equal(n1.source, 'rules'); assert.equal(n1.python.id, '');
  for (const t of TEMPLATES) assert.ok(compileStrategy(t.strategy).ok, t.name);
});

test('編譯: Python 策略必須選一個 id,規則語法的欄位(進場、指標、參數)不再檢查;止損止盈與成本照樣檢查', () => {
  const base = { ...emptyStrategy(), source: 'python' };
  const none = compileStrategy(base);
  assert.equal(none.ok, false);
  assert.deepEqual(none.errors.map((e) => e.field), ['python.id']);
  const bad = compileStrategy({ ...base, python: { id: '../x', params: {}, checkLookahead: true } });
  assert.deepEqual(bad.errors.map((e) => e.field), ['python.id']);
  const ok = compileStrategy({ ...base, python: { id: 'sma_cross', params: { fast: 5 }, checkLookahead: true }, entry: { long: 'this is not valid ((', short: '' }, indicators: [{ name: 'x', expr: '???' }] });
  assert.ok(ok.ok, JSON.stringify(ok.errors));
  assert.deepEqual(ok.compiled.python, { id: 'sma_cross', params: { fast: 5 }, checkLookahead: true });
  assert.deepEqual(ok.compiled.indicators, []);
  assert.equal(ok.warnings.length, 0);
  const stops = compileStrategy({ ...base, python: { id: 'a', params: {}, checkLookahead: true }, stopLoss: { mode: 'pct', pct: 500, atrN: 14, atrMult: 2, expr: '' }, costs: { commissionBps: -1, slippageBps: 5 } });
  assert.deepEqual(stops.errors.map((e) => e.field).sort(), ['costs.commissionBps', 'stopLoss']);
  assert.equal(compileStrategy(emptyStrategy()).compiled?.python ?? null, null, '規則策略的 compiled.python 是 null');
});

test('分享連結: Python 策略的設定跟著策略走(對方需要有同一個檔案)', () => {
  const s = normalizeStrategy({ source: 'python', python: { id: 'sma_cross', params: { fast: 7 }, checkLookahead: false }, name: 'P' });
  const back = normalizeStrategy(decodeShare(encodeShare({ strategy: s })).strategy);
  assert.deepEqual(back.python, s.python); assert.equal(back.source, 'python');
});

test('訊號轉換: 0/1 旗標、暖機與 NaN 的遮罩、止損止盈(沒給就用編輯器的設定)', () => {
  const c = compileStrategy({ ...emptyStrategy(), source: 'python', python: { id: 'a', params: {}, checkLookahead: true }, warmupBars: 10, stopLoss: { mode: 'pct', pct: 4, atrN: 14, atrMult: 2, expr: '' } });
  const base = computeSignals(c.compiled, bars);
  const entry = zeros(); entry[20] = 1; entry[30] = true; entry[40] = 2;
  const valid = Array(n).fill(1); valid[50] = 0;
  const sig = signalsFromPython({ ok: true, signals: { entry_long: entry, exit_long: zeros(), entry_short: zeros(), exit_short: zeros(), stop_loss_pct: null, take_profit_pct: null }, valid }, bars, base);
  assert.ok(sig.entryLong instanceof Uint8Array);
  assert.deepEqual([sig.entryLong[20], sig.entryLong[30], sig.entryLong[40], sig.entryLong[21]], [1, 1, 1, 0]);
  assert.deepEqual([sig.valid[5], sig.valid[10], sig.valid[50], sig.valid[51]], [0, 1, 0, 1], '暖機 10 根 + Python 的 NaN 位置都不交易');
  assert.equal(sig.slPct[15], 4, '沒有給止損 → 用編輯器設定的 4%');
  assert.ok(sig.tpPct === null || Number.isNaN(sig.tpPct[15]) || sig.tpPct === base.tpPct);
  const sl = Array(n).fill(null); sl[25] = 2.5; sl[26] = -3; sl[27] = 0;
  const sig2 = signalsFromPython({ ok: true, signals: { entry_long: zeros(), exit_long: zeros(), entry_short: zeros(), exit_short: zeros(), stop_loss_pct: sl, take_profit_pct: Array(n).fill(8) }, valid: Array(n).fill(1) }, bars, base);
  assert.equal(sig2.slPct[25], 2.5); assert.ok(Number.isNaN(sig2.slPct[26]) && Number.isNaN(sig2.slPct[27]) && Number.isNaN(sig2.slPct[0]), '非正數與 null 都是「不設」');
  assert.equal(sig2.tpPct[3], 8);
});

test('訊號轉換: 長度或格式不對就丟出清楚的錯誤', () => {
  const c = compileStrategy({ ...emptyStrategy(), source: 'python', python: { id: 'a', params: {}, checkLookahead: true } });
  const base = computeSignals(c.compiled, bars);
  assert.throws(() => signalsFromPython(null, bars, base), /回應格式不正確/);
  assert.throws(() => signalsFromPython({ signals: { entry_long: [1], exit_long: zeros(), entry_short: zeros(), exit_short: zeros() }, valid: Array(n).fill(1) }, bars, base), /entry_long 長度與資料不同\(1 vs 120\)/);
  assert.throws(() => signalsFromPython({ signals: { entry_long: zeros(), exit_long: zeros(), entry_short: zeros() }, valid: Array(n).fill(1) }, bars, base), /exit_short 長度與資料不同\(沒有 vs 120\)/);
  assert.throws(() => signalsFromPython({ signals: { entry_long: zeros(), exit_long: zeros(), entry_short: zeros(), exit_short: zeros() }, valid: [1] }, bars, base), /valid 長度與資料不同/);
  assert.throws(() => signalsFromPython({ signals: { entry_long: zeros(), exit_long: zeros(), entry_short: zeros(), exit_short: zeros(), stop_loss_pct: [1, 2] }, valid: Array(n).fill(1) }, bars, base), /止損 \/ 止盈序列長度/);
});

test('警告文字: 偷看未來、策略的輸出與警告、沒有結論;一切正常就沒有警告', () => {
  assert.deepEqual(pythonWarnings({ lookahead: { checked: true, ok: true }, warnings: [], log: '' }, 'AAPL'), []);
  const w = pythonWarnings({ lookahead: { checked: true, ok: false, cut: 300, date: '2023-05-04', key: 'entry_long' }, warnings: ['部位的大小被忽略'], log: 'a\nb\nc\nd' }, 'AAPL');
  assert.equal(w.length, 3);
  assert.match(w[0], /AAPL.*疑似用到了未來的資料.*前 300 根.*2023-05-04.*entry_long.*shift\(-1\)/);
  assert.match(w[1], /AAPL: 部位的大小被忽略/);
  assert.match(w[2], /Python 策略的輸出\(AAPL\): a ⏎ b ⏎ c …/);
  assert.match(pythonWarnings({ lookahead: { checked: true, ok: true, inconclusive: '截短到 50 根時執行失敗' } }, 'X')[0], /沒有結論/);
  assert.deepEqual(pythonWarnings({ lookahead: { checked: false, reason: '已關閉檢查' } }, 'X'), []);
});

test('組合回測: Python 策略沒有給訊號就拒絕執行(不會悄悄退回規則語法);給了就用', () => {
  const c = compileStrategy({ ...emptyStrategy(), source: 'python', python: { id: 'a', params: {}, checkLookahead: true }, warmupBars: 0 });
  const assets = [{ id: 'X', bars, weight: 1 }];
  assert.throws(() => runPortfolio({ assets, compiled: c.compiled, capital: 1000 }), /缺少 X 的 Python 策略訊號/);
  assert.throws(() => runPortfolio({ assets, compiled: c.compiled, capital: 1000, externalSignals: { Y: {} } }), /缺少 X 的 Python 策略訊號/);
  const entry = zeros(); entry[5] = 1;
  const exit = zeros(); exit[20] = 1;
  const sig = signalsFromPython(resp({ signals: { entry_long: entry, exit_long: exit } }), bars, computeSignals(c.compiled, bars));
  const r = runPortfolio({ assets, compiled: c.compiled, capital: 100000, externalSignals: { X: sig } });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryDate, bars.d[6], '第 5 根收盤的訊號 → 第 6 根開盤成交');
  assert.equal(r.trades[0].exitDate, bars.d[21]);
});
