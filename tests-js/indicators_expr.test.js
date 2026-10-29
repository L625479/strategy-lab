import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ExprError, analyze, asSignal, evaluate, parse } from '../site/js/engine/expr.js';
import * as ind from '../site/js/engine/indicators.js';
import { makeBars } from './helpers.js';

const F = (xs) => Float64Array.from(xs);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const arrNear = (actual, expected, eps = 1e-9) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((e, i) => (Number.isNaN(e) ? assert.ok(Number.isNaN(actual[i]), `[${i}] 應為 NaN,實際 ${actual[i]}`) : near(actual[i], e, eps)));
};

// StockCharts 的 RSI 教學範例(收盤價四捨五入,所以允許 0.1 誤差)
const SC_CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
const SC_RSI = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97, 62.93, 63.26, 56.06, 62.38, 54.71, 50.42, 39.99, 41.46, 41.87, 45.46, 37.30, 33.08, 37.77];

test('RSI 對照 Wilder 經典範例', () => {
  const out = Array.from(ind.rsi(F(SC_CLOSES), 14)).filter((x) => !Number.isNaN(x));
  assert.equal(out.length, SC_RSI.length);
  out.forEach((v, i) => near(v, SC_RSI[i], 0.1));
});

test('RSI 極端值: 只漲 → 100,只跌 → 0,全平 → 100(Pine 規則)', () => {
  assert.equal(ind.rsi(F(Array.from({ length: 40 }, (_, i) => i + 1)), 14).at(-1), 100);
  assert.equal(ind.rsi(F(Array.from({ length: 40 }, (_, i) => 40 - i)), 14).at(-1), 0);
  assert.equal(ind.rsi(F(new Array(40).fill(5)), 14).at(-1), 100);
});

test('EMA: 第一個值當 seed,之後遞迴', () => {
  const x = F([10, 11, 12, 11, 13, 15]), a = 2 / 4, exp = [10];
  for (let i = 1; i < x.length; i++) exp.push(a * x[i] + (1 - a) * exp[i - 1]);
  arrNear(ind.ema(x, 3), exp);
});

test('RMA: 前 n 個的平均當 seed,之後 alpha = 1/n', () => {
  const seed = 2;                                   // (1+2+3)/3
  const r3 = (4 + 2 * seed) / 3, r4 = (5 + 2 * r3) / 3, r5 = (6 + 2 * r4) / 3;
  arrNear(ind.rma(F([1, 2, 3, 4, 5, 6]), 3), [NaN, NaN, seed, r3, r4, r5]);
});

test('SMA / highest / lowest / stdev(母體)', () => {
  arrNear(ind.sma(F([1, 2, 3, 4, 5]), 3), [NaN, NaN, 2, 3, 4]);
  arrNear(ind.highest(F([1, 3, 2, 5, 4]), 2), [NaN, 3, 3, 5, 5]);
  arrNear(ind.lowest(F([1, 3, 2, 5, 4]), 2), [NaN, 1, 2, 2, 4]);
  near(ind.stdev(F([3, 4, 5]), 3)[2], Math.sqrt(2 / 3));
});

test('crossover / crossunder 語意', () => {
  const a = F([1, 2, 3, 2, 1]), b = F([2, 2, 2, 2, 2]);
  assert.deepEqual(Array.from(ind.crossover(a, b)), [0, 0, 1, 0, 0]);
  assert.deepEqual(Array.from(ind.crossunder(a, b)), [0, 0, 0, 0, 1]);
});

test('ATR: 固定振幅 → 等於振幅', () => {
  near(ind.atr(F(new Array(20).fill(11)), F(new Array(20).fill(9)), F(new Array(20).fill(10)), 5)[19], 2);
});

test('shift 不允許看未來; change; roc; zscore; macd; 布林帶', () => {
  assert.ok(ind.shift(F([1, 2, 3]), -1).every(Number.isNaN));
  arrNear(ind.shift(F([1, 2, 3]), 1), [NaN, 1, 2]);
  arrNear(ind.change(F([1, 3, 6]), 1), [NaN, 2, 3]);
  arrNear(ind.roc(F([100, 110]), 1), [NaN, 10]);
  const x = F([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  near(ind.zscore(x, 5)[9], (10 - 8) / Math.sqrt(2));
  near(ind.bbUpper(x, 5, 2)[9] - ind.sma(x, 5)[9], 2 * Math.sqrt(2));
  near(ind.macd(x, 3, 6)[9], ind.ema(x, 3)[9] - ind.ema(x, 6)[9]);
});

// ---- 規則語法 ---------------------------------------------------------------

const bars = makeBars(Array.from({ length: 6 }, (_, i) => [10 + i, 11 + i, 9 + i, 10 + i]));
const funcs = ind.makeFunctions(bars);
const env = Object.assign(Object.create(null), { close: bars.c, x: F([0, 1, 2, 3, 4, 5]), k: 3 });
const ev = (src) => evaluate(parse(src), { env, funcs });
const sig = (src) => Array.from(asSignal(ev(src), 6));

test('運算子優先順序與括號', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('-2 + 5'), 3);
  assert.equal(ev('10 % 4 + 8 / 2'), 6);
  arrNear(ev('x * 2 + 1'), [1, 3, 5, 7, 9, 11]);
});

test('比較、鏈式比較、and / or / not(含 && || !)', () => {
  assert.deepEqual(sig('x > 2'), [0, 0, 0, 1, 1, 1]);
  assert.deepEqual(sig('1 < x < 4'), [0, 0, 1, 1, 0, 0]);
  assert.deepEqual(sig('x == 0 or x >= 5'), [1, 0, 0, 0, 0, 1]);
  assert.deepEqual(sig('x > 1 and x < 4'), [0, 0, 1, 1, 0, 0]);
  assert.deepEqual(sig('not (x > 1)'), [1, 1, 0, 0, 0, 0]);
  assert.deepEqual(sig('x > 1 && !(x > 3) || x == 0'), [1, 0, 1, 1, 0, 0]);
  assert.deepEqual(sig('x != 2'), [1, 1, 0, 1, 1, 1]);
  assert.deepEqual(sig('true'), [1, 1, 1, 1, 1, 1]);
});

test('and 優先於 or;not 優先於 and', () => {
  assert.deepEqual(sig('x == 0 or x == 1 and x == 2'), [1, 0, 0, 0, 0, 0]);
  assert.deepEqual(sig('not x == 0 and x < 2'), [0, 1, 0, 0, 0, 0]);
});

test('歷史索引 x[n]:取前 n 根,可接在函式結果後面', () => {
  arrNear(ev('x[1]'), [NaN, 0, 1, 2, 3, 4]);
  arrNear(ev('sma(x, 2)[1]'), [NaN, NaN, 0.5, 1.5, 2.5, 3.5]);
  assert.equal(ev('5[3]'), 5);
});

test('NaN 視為 false(暖機期不會誤觸發),not NaN 為 true(同 Pine)', () => {
  assert.deepEqual(sig('x[1] > 0'), [0, 0, 1, 1, 1, 1]);
  assert.deepEqual(sig('not (x[2] > 100)'), [1, 1, 1, 1, 1, 1]);
});

test('函式: 純量週期、參數個數與型別檢查', () => {
  arrNear(ev('sma(close, k)'), [NaN, NaN, 11, 12, 13, 14]);
  assert.deepEqual(sig('cross_above(x, 2.5)'), [0, 0, 0, 1, 0, 0]);
  assert.throws(() => ev('ema(close)'), /需要 2 個參數/);
  assert.throws(() => ev('ema(close, close)'), /必須是數字/);
  assert.throws(() => ev('atr(close)'), /必須是數字/);
  assert.throws(() => ev('nope(1)'), /不認得的函式/);
  assert.throws(() => ev('nope + 1'), /不認得的名稱/);
});

test('analyze 回傳用到的名稱與函式', () => {
  const { names, calls } = analyze(parse('cross_above(ema_f, ema_s) and rsi_v < 70'));
  assert.deepEqual([...names].sort(), ['ema_f', 'ema_s', 'rsi_v']);
  assert.deepEqual([...calls.keys()], ['cross_above']);
  const same = analyze(parse('rsi(close, 14) < rsi'));
  assert.ok(same.names.has('rsi') && same.calls.has('rsi')); // 函式與變數同名互不干擾
});

for (const [src, pattern] of [
  ['', /空/], ['   ', /空/], ['x >', /突然結束/], ['x > > 1', /不該出現/], ['(x > 1', /缺少|沒有成對/], ['x > 1)', /多餘/],
  ['x = 1', /==/], ['x[-1]', /整數/], ['x[1.5]', /整數/], ['x[y]', /整數/], ['ema(close, 5', /缺少/], ['x $ 1', /不認得的符號/],
  ['x > 1 x < 2', /多餘/], ['close[', /整數/], ['1 +', /突然結束/],
]) {
  test(`語法錯誤有清楚的訊息: ${JSON.stringify(src)}`, () => {
    assert.throws(() => parse(src), (e) => e instanceof ExprError && pattern.test(e.message), `應符合 ${pattern}`);
  });
}

test('安全性: 無法存取 JavaScript 物件或執行程式碼', () => {
  const evil = [
    'constructor', '__proto__', 'toString', 'hasOwnProperty', 'process', 'globalThis', 'this', 'window',
    'constructor("return 1")()', 'process.exit()', '(()=>1)()', 'x.constructor', '`1`', '"abc"', "'a'", 'import("x")',
    'x ? 1 : 2', '{}', '[1,2]', 'eval("1")', 'Function("return 1")()', 'x; y', 'x ** 2',
  ];
  for (const src of evil) {
    assert.throws(() => ev(src), ExprError, `應拒絕: ${src}`);
  }
});

test('過長或巢狀過深的規則被拒絕', () => {
  assert.throws(() => parse('1 +'.repeat(300) + '1'), /太長/);
  assert.throws(() => parse('('.repeat(100) + '1' + ')'.repeat(100)), /太深/);
});
