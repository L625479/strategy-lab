// 盤中 K 線驗證的單元測試: 用手算得出答案的小例子釘住每一條成交規則(不依賴 Python 的標準答案)。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileGrid } from '../site/js/engine/daytrade.js';
import { alignIntraday, allDaysSegment, evaluateIntraday, halfSegments, prepareTicker, simulateIntradayDays } from '../site/js/engine/intraday.js';

const NAN = NaN;
const F = (a) => Float32Array.from(a);

/** 一檔標的、一天的盤中檔。bars = [[high, low], ...],開盤 o、收盤 c。 */
function oneDay(bars, o, c, dates = ['2024-01-02']) {
  const n = dates.length, nb = bars.length / n;
  return { dates, nb, m: 1, tickers: null, H: F(bars.map((b) => b[0])), L: F(bars.map((b) => b[1])), O: F(Array.isArray(o) ? o : [o]), C: F(Array.isArray(c) ? c : [c]) };
}
const panel1 = (dates) => ({ dates, tickers: ['X'], o: [], h: [], l: [], c: [], aux: {} });

/** 單日模擬,回傳成交的淨報酬(沒成交 = null)。cost 預設 0、buffer 預設 0.01(讓邊界好算)。 */
function sim(intra, { side = 'long', dist = null, tp = null, optimistic = false, cost = 0, buffer = 0.01 } = {}) {
  const a = alignIntraday(panel1(intra.dates), intra);
  const prep = prepareTicker(a, 0);
  const out = [];
  const series = (v) => (v === null ? null : Float64Array.from({ length: a.n }, () => v));
  simulateIntradayDays(prep, Int32Array.from({ length: a.n }, (_, d) => d), series(dist), series(tp), side, { optimistic, cost, buffer }, (d, r) => out.push([d, r]));
  return out;
}
const only = (out) => { assert.ok(out.length <= 1); return out.length ? out[0][1] : null; };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg || ''} ${a} vs ${b}`);

// 4 根 K 棒,開盤 100。高低: [102,99] [103,96] [104,98] [101,95]
const BARS = [[102, 99], [103, 96], [104, 98], [101, 95]];

test('開盤市價 + 收盤出場: 報酬 = 收盤 / 開盤 - 1,和 K 棒無關', () => {
  near(only(sim(oneDay(BARS, 100, 103))), 0.03);
  near(only(sim(oneDay(BARS, 100, 103), { side: 'short' })), -0.03);
  near(only(sim(oneDay(BARS, 100, 103), { cost: 0.0005 })), 0.03 - 0.001, '來回成本 = 2 × 單邊');
});

test('開盤市價 + 停利: 停利價在任何一根 K 棒被穿價就成交在停利價(含第一根),沒到就收盤', () => {
  // T = 100 × 1.03 = 103,要穿價 1%: 高點 ≥ 104.03。最高只有 104 → 沒到
  near(only(sim(oneDay(BARS, 100, 101), { tp: 0.03 })), 0.01);
  // T = 102(2%),要 ≥ 103.02: 第三根最高 104 → 成交在 102
  near(only(sim(oneDay(BARS, 100, 101), { tp: 0.02 })), 0.02);
  // 第一根就到(高點 105 ≥ 101 × 1.01 = 102.01 的 T = 101)
  near(only(sim(oneDay([[105, 99], ...BARS.slice(1)], 100, 90), { tp: 0.01 })), 0.01);
  // 市價進場: 保守與樂觀相同
  const a = only(sim(oneDay(BARS, 100, 101), { tp: 0.02 })), b = only(sim(oneDay(BARS, 100, 101), { tp: 0.02, optimistic: true }));
  assert.equal(a, b);
});

test('限價進場: 低點要穿過 E × (1 - 緩衝) 才成交,剛好等於也算;成交價是 E', () => {
  // 開盤 100、距離 5% → E = 95;緩衝 1% → 門檻 94.05。最低 96/95/98/... 第四根 95 不夠
  assert.equal(only(sim(oneDay(BARS, 100, 100), { dist: 0.05 })), null, '最低 95 > 94.05: 沒成交');
  // 把第二根的低點改成 94.05(可以精確比較的數字改用 2 的冪: 緩衝 0.125)
  const exact = [[102, 99], [103, 87.5], [104, 98], [101, 95]];       // E = 100 × (1 - 0.0) ... 用 dist = 0 以外的值:
  // 開盤 100、距離 0 的限價(掛在開盤價):門檻 = 100 × (1 - 0.125) = 87.5;低點 87.5 剛好 → 成交
  near(only(sim(oneDay(exact, 100, 110), { dist: 0, buffer: 0.125 })), 0.1, '低點剛好等於門檻 → 成交在 E = 100,收盤 110');
  const miss = [[102, 99], [103, 87.5001], [104, 98], [101, 95]];
  assert.equal(only(sim(oneDay(miss, 100, 110), { dist: 0, buffer: 0.125 })), null, '差一點點 → 沒成交');
});

test('限價進場 + 停利: 成交那一根裡的停利,保守不算、樂觀算;成交之後的 K 棒兩種都算', () => {
  // E = 100 × (1 - 0.04) = 96,門檻 96 × 0.99 = 95.04: 第二根低點 96 不夠,第四根 95 夠 → 在第四根(j = 3)成交
  // 為了讓成交在第二根: 把第二根低點改 95(≤ 95.04)
  const b = [[102, 99], [103, 95], [104, 98], [101, 97]];
  // T = 96 × 1.03 = 98.88,穿價 1% → 高點 ≥ 99.8688
  // 第二根高點 103 ≥ 99.87 → 樂觀(從 j = 1 起)算停利;保守(從 j + 1 = 2 起): 第三根高點 104 也 ≥ 99.87 → 也算
  near(only(sim(oneDay(b, 100, 97), { dist: 0.04, tp: 0.03 })), 98.88 / 96 - 1, '保守: 第三根(成交之後)碰到');
  near(only(sim(oneDay(b, 100, 97), { dist: 0.04, tp: 0.03, optimistic: true })), 98.88 / 96 - 1);
  // 讓第三、四根都碰不到: 只有成交那一根(第二根)高點夠高
  const c = [[102, 99], [103, 95], [99.5, 98], [99, 97]];
  near(only(sim(oneDay(c, 100, 97), { dist: 0.04, tp: 0.03 })), 97 / 96 - 1, '保守: 成交那一根不算,之後都沒碰到 → 收盤 97 出場');
  near(only(sim(oneDay(c, 100, 97), { dist: 0.04, tp: 0.03, optimistic: true })), 98.88 / 96 - 1, '樂觀: 成交那一根也算');
});

test('停利價早在成交之前就碰過(更早的 K 棒): 兩種算法都不算', () => {
  // 第一根高點 120 ≥ 任何停利價,但限價要到第三根才成交(E = 96,門檻 95.04,第三根低點 95)
  const b = [[120, 99], [103, 96], [98, 95], [97, 96]];
  near(only(sim(oneDay(b, 100, 97), { dist: 0.04, tp: 0.03 })), 97 / 96 - 1);
  near(only(sim(oneDay(b, 100, 97), { dist: 0.04, tp: 0.03, optimistic: true })), 97 / 96 - 1);
});

test('最後一根才成交: 保守沒有「之後的 K 棒」所以不可能停利,樂觀只看這一根', () => {
  const b = [[101, 99], [101, 99], [101, 99], [110, 95]];                // 只有第四根(最後一根)的低點到 95
  near(only(sim(oneDay(b, 100, 97), { dist: 0.04, tp: 0.03 })), 97 / 96 - 1, '保守: 收盤出場');
  near(only(sim(oneDay(b, 100, 97), { dist: 0.04, tp: 0.03, optimistic: true })), 98.88 / 96 - 1, '樂觀: 同一根的高點 110 ≥ 99.87');
});

test('停利穿價的邊界: 高點剛好等於 T × (1 + 緩衝) 算停利(≥),差一點點不算', () => {
  // 市價進場,T = 100 × 1.5 = 150,緩衝 0.125 → 門檻 168.75(可精確表示)
  const hit = [[168.75, 99], [101, 99], [101, 99], [101, 99]];
  near(only(sim(oneDay(hit, 100, 90), { tp: 0.5, buffer: 0.125 })), 0.5);
  const miss = [[168.7499, 99], [101, 99], [101, 99], [101, 99]];
  near(only(sim(oneDay(miss, 100, 90), { tp: 0.5, buffer: 0.125 })), -0.1);
});

test('放空是做多的鏡像: 限價掛在開盤上方、高點穿價成交、低點碰到停利', () => {
  // 開盤 100,放空限價距離 4% → E = 104,門檻 104 × 1.01 = 105.04: 第二根高點 106 成交(j = 1)
  const b = [[101, 99], [106, 100], [103, 97], [102, 98]];
  // T = 104 × (1 - 0.03) = 100.88,穿價: 低點 ≤ 100.88 × 0.99 = 99.8712。保守從第三根起: 低點 97 ✓
  near(only(sim(oneDay(b, 100, 101), { side: 'short', dist: 0.04, tp: 0.03 })), -(100.88 / 104 - 1));
  // 讓第三、四根低點碰不到 99.87,只有第二根低點 99 碰到
  const c = [[101, 99], [106, 99], [103, 100], [102, 100]];
  near(only(sim(oneDay(c, 100, 101), { side: 'short', dist: 0.04, tp: 0.03 })), -(101 / 104 - 1), '保守: 成交那一根不算 → 收盤 101 回補');
  near(only(sim(oneDay(c, 100, 101), { side: 'short', dist: 0.04, tp: 0.03, optimistic: true })), -(100.88 / 104 - 1), '樂觀');
  assert.equal(only(sim(oneDay([[101, 99], [103, 97], [102, 98], [101, 99]], 100, 101), { side: 'short', dist: 0.04 })), null, '高點只到 103 < 105.04: 沒成交');
});

test('缺值: 缺的 K 棒略過、整天沒有 K 棒的市價單照收盤出場、開盤缺值不交易、收盤缺值只有停利成交時才有結果', () => {
  // 缺棒(NaN)不影響其他 K 棒: 第二根缺,第三根低點 95 成交在 j = 2
  const b = [[102, 99], [NAN, NAN], [104, 95], [101, 97]];
  near(only(sim(oneDay(b, 100, 97), { dist: 0.04 })), 97 / 96 - 1);
  // 整天沒有 K 棒:限價沒成交;市價單收盤出場;市價 + 停利永遠不會碰到
  const none = [[NAN, NAN], [NAN, NAN], [NAN, NAN], [NAN, NAN]];
  assert.equal(only(sim(oneDay(none, 100, 101), { dist: 0.01 })), null);
  near(only(sim(oneDay(none, 100, 101))), 0.01);
  near(only(sim(oneDay(none, 100, 101), { tp: 0.02 })), 0.01);
  // 開盤缺值: 不交易
  assert.equal(only(sim(oneDay(BARS, NAN, 101))), null);
  assert.equal(only(sim(oneDay(BARS, NAN, 101), { dist: 0.01 })), null);
  // 收盤缺值: 沒停利 → 沒有結果;停利成交 → 照停利價算(和使用者的 np.where(hit, T, C) 相同)
  assert.equal(only(sim(oneDay(BARS, 100, NAN))), null);
  near(only(sim(oneDay(BARS, 100, NAN), { tp: 0.02 })), 0.02);
  assert.equal(only(sim(oneDay(BARS, 100, NAN), { tp: 0.5 })), null, '停利沒到 → 用收盤 → NaN → 不算一筆');
});

test('距離或幅度算出來是負數 / NaN 的日子不交易', () => {
  assert.equal(only(sim(oneDay(BARS, 100, 101), { dist: -0.01 })), null);
  assert.equal(only(sim(oneDay(BARS, 100, 101), { dist: NAN })), null);
  assert.equal(only(sim(oneDay(BARS, 100, 101), { tp: -0.01 })), null);
  assert.equal(only(sim(oneDay(BARS, 100, 101), { tp: NAN })), null);
});

test('prepareTicker: 累積高低點與「之後」的高低點(多一格代表沒有 K 棒)', () => {
  const intra = oneDay([[102, 99], [NAN, NAN], [104, 98], [101, 95]], 100, 97);
  const p = prepareTicker(alignIntraday(panel1(intra.dates), intra), 0);
  assert.deepEqual([...p.lo], [99, 99, 98, 95]);
  assert.deepEqual([...p.hi], [102, 102, 104, 104]);
  assert.deepEqual([...p.loAfter], [95, 95, 95, 95, Infinity]);
  assert.deepEqual([...p.hiAfter], [104, 104, 104, 101, -Infinity]);
  const empty = oneDay([[NAN, NAN], [NAN, NAN]], 100, 97);
  const e = prepareTicker(alignIntraday(panel1(empty.dates), empty), 0);
  assert.deepEqual([...e.lo], [Infinity, Infinity]);
  assert.deepEqual([...e.hiAfter], [-Infinity, -Infinity, -Infinity]);
});

// ---- 整條流程: 日線的條件 / 距離 / 停利 + 盤中 K 棒 -----------------------------------------------

function tinyWorld() {
  // 日線 8 天、一檔標的(價格固定在 100 附近,K 棒品質正常)。盤中檔: 其中 6 天有資料,另外多一個不在日線日曆上的日期
  const dates = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10', '2024-01-11'];
  const px = (v) => Float64Array.from(dates, () => v);
  const panel = { dates, tickers: ['X'], o: [px(100)], h: [px(101)], l: [px(99)], c: [px(100)], aux: {} };
  const intraDates = ['2024-01-03', '2024-01-04', '2024-01-05', '2024-01-06', '2024-01-08', '2024-01-09', '2024-01-10'];    // 01-06 是週六
  const n = intraDates.length, nb = 4;
  const H = new Float32Array(n * nb).fill(101), L = new Float32Array(n * nb).fill(99);
  const O = new Float32Array(n).fill(100), C = new Float32Array(n).fill(100);
  // 01-04 (index 1): 第二根低點 94 → 限價 5%(E = 95,門檻 94.905)成交;之後第三根高點 110 → 停利 15%(T = 109.25,穿價門檻 109.359)
  L[1 * nb + 1] = 94; H[1 * nb + 2] = 110; C[1] = 97;
  // 01-05 (index 2): 沒有任何一根低於 95
  C[2] = 102;
  // 01-06 (index 3): 週六,不在日線日曆上 → 略過;就算有大跌也不該出現
  L[3 * nb + 0] = 50;
  // 01-08 (index 4): 成交與停利出現在同一根 (index 0): 低 94、高 110,其餘平靜
  L[4 * nb + 0] = 94; H[4 * nb + 0] = 110; C[4] = 98;
  return { panel, intra: { dates: intraDates, nb, m: 1, tickers: null, H, L, O, C } };
}

function grid(extra = {}) {
  const g = compileGrid({
    name: 't', indicators: [], aux: [], costBps: 0, bufferBps: 10,
    setups: [{ side: 'long', name: 'always', expr: 'true' }, { side: 'long', name: 'tue', expr: 'open > 100.5' }],
    entries: [{ name: 'open', expr: '' }, { name: 'lim5', expr: '0.05' }],
    exits: [{ name: 'close', expr: '' }, { name: 'tp5', expr: '0.05' }, { name: 'tp15', expr: '0.15' }],
    ...extra,
  });
  assert.ok(g.ok, JSON.stringify(g.errors));
  return g.compiled;
}

test('整條流程: 日期對齊、條件用日線、成交用盤中 K 棒、保守與樂觀在同一根 K 棒的差別', () => {
  const { panel, intra } = tinyWorld();
  const a = alignIntraday(panel, intra);
  assert.deepEqual(a.dates, ['2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08', '2024-01-09', '2024-01-10']);
  assert.equal(a.skippedDates, 1);
  assert.deepEqual([...a.rows], [1, 2, 3, 4, 5, 6]);
  const out = evaluateIntraday(panel, a, grid(), { segments: allDaysSegment(a.n), variants: ['cons', 'opt'], median: true });
  const by = Object.fromEntries(out.rules.map((r) => [r.key, r.stats]));
  const cons = (k) => by[k].cons.all, opt = (k) => by[k].opt.all;

  // 開盤市價 + 收盤出場: 6 天,每天 C/O - 1: [0, -3%, +2%, -2%, 0, 0]
  const m = cons('long|always|open|close');
  assert.equal(m.n, 6);
  near(m.mean, (0 - 0.03 + 0.02 - 0.02 + 0 + 0) / 6);
  assert.equal(m.days, 6);
  near(m.win, 1 / 6);
  // 限價 5% + 收盤出場: 只有 01-04 與 01-08 成交(E = 95): (97 / 95 - 1) 與 (98 / 95 - 1)
  const l = cons('long|always|lim5|close');
  assert.equal(l.n, 2);
  near(l.mean, (97 / 95 - 1 + 98 / 95 - 1) / 2);
  // 限價 5% + 停利 15%: T = 95 × 1.15 = 109.25,穿價門檻 109.359(平常的高點 101 碰不到)。
  //   01-04: 成交在第二根,之後第三根高 110 ≥ 門檻 → 停利。
  //   01-08: 成交與高點 110 在同一根: 保守不算 → 收盤 98;樂觀算 → 停利
  const lt = cons('long|always|lim5|tp15'), lo = opt('long|always|lim5|tp15');
  assert.equal(lt.n, 2);
  near(lt.mean, (109.25 / 95 - 1 + 98 / 95 - 1) / 2);
  near(lo.mean, 109.25 / 95 - 1);
  assert.ok(lo.mean > lt.mean);
  // 市價 + 停利 5%: T = 105(穿價門檻 105.105),平常的高點 101 碰不到,01-04 與 01-08 的高點 110 碰到 → 停利
  const mt = cons('long|always|open|tp5');
  near(mt.mean, (0 + 0.05 + 0.02 + 0.05 + 0 + 0) / 6, '01-03 收 100(0)、01-04 停利 +5%、01-05 收 102(+2%)、01-08 停利 +5%、其餘 0');
  // 市價進場時樂觀 = 保守
  assert.deepEqual(opt('long|always|open|tp5'), cons('long|always|open|tp5'));
  assert.equal(by['long|always|open|tp5'].opt.all.n, 6);
  // 條件 open > 100.5: 日線的開盤都是 100 → 永遠不成立,沒有任何交易
  assert.equal(cons('long|tue|open|close').n, 0);
});

test('整條流程: 日線資料品質不合格的日子(高低價矛盾)即使盤中有資料也不交易;缺指標值的日子也不交易', () => {
  const { panel, intra } = tinyWorld();
  panel.h[0][2] = 90;                                          // 2024-01-04 的日線高點 90 < 開收 100 的 0.995 倍 → 壞資料
  const a = alignIntraday(panel, intra);
  const out = evaluateIntraday(panel, a, grid(), { segments: allDaysSegment(a.n), variants: ['cons'] });
  assert.equal(out.rules.find((r) => r.key === 'long|always|open|close').stats.cons.all.n, 5);
  // 指標需要 3 日均線 → 面板前 2 天沒有值,盤中檔從 01-03 開始(面板第 2 列,3 日均線的第一個值在第 3 列之後)
  const withInd = grid({ indicators: [{ name: 'm3', expr: 'sma(close, 3)' }] });
  const out2 = evaluateIntraday(panel, alignIntraday(panel, intra), withInd, { segments: allDaysSegment(6), variants: ['cons'] });
  const n = out2.rules.find((r) => r.key === 'long|always|open|close').stats.cons.all.n;
  assert.ok(n < 5, `前面幾天沒有指標值: ${n}`);
});

test('標的在盤中檔沒有資料: 跳過那一檔,但仍算在「個股」的分母裡', () => {
  const { panel, intra } = tinyWorld();
  const px = (v) => Float64Array.from(panel.dates, () => v);
  const two = { ...panel, tickers: ['X', 'Y'], o: [px(100), px(100)], h: [px(101), px(101)], l: [px(99), px(99)], c: [px(100), px(100)] };
  const a = alignIntraday(two, { ...intra, tickers: ['X'] });
  assert.equal(a.matched, 1);
  const out = evaluateIntraday(two, a, grid(), { segments: allDaysSegment(a.n), variants: ['cons'] });
  const s = out.rules.find((r) => r.key === 'long|always|open|close').stats.cons.all;
  assert.equal(s.n, 6);
  assert.equal(s.elig, 0.5, '2 檔裡只有 1 檔有交易');
});

test('切分: 60 分 K 對半切,天數是奇數時後半多一天;最小筆數預設 I1/I2 = 5、5 分 K = 1', () => {
  const [i1, i2] = halfSegments(7);
  assert.deepEqual(i1.rows, [true, true, true, false, false, false, false]);
  assert.deepEqual(i2.rows, [false, false, false, true, true, true, true]);
  assert.deepEqual([i1.minTrades, i2.minTrades], [5, 5]);
  assert.deepEqual(halfSegments(6).map((s) => s.rows.filter(Boolean).length), [3, 3]);
  const [all] = allDaysSegment(3);
  assert.deepEqual(all.rows, [true, true, true]);
  assert.equal(all.minTrades, 1);
});

// ---- 補強: 放空的邊界、合格判定逐項、壞檔案 ----------------------------------------------------

test('放空的邊界: 成交 — 高點剛好等於 E × (1 + 緩衝) 算成交;停利 — 低點剛好等於 T × (1 - 緩衝) 算停利', () => {
  // 開盤 100、距離 0 → E = 100,緩衝 0.125 → 成交門檻 112.5
  const fill = [[112.5, 99], [101, 99], [101, 99], [101, 99]];
  near(only(sim(oneDay(fill, 100, 90), { side: 'short', dist: 0, buffer: 0.125 })), -(90 / 100 - 1), '高點剛好 112.5 → 成交,收盤 90 回補');
  const miss = [[112.4999, 99], [101, 99], [101, 99], [101, 99]];
  assert.equal(only(sim(oneDay(miss, 100, 90), { side: 'short', dist: 0, buffer: 0.125 })), null, '差一點點 → 沒成交');
  // 市價放空、停利 50% → T = 50,穿價門檻 50 × 0.875 = 43.75
  const hit = [[101, 43.75], [101, 99], [101, 99], [101, 99]];
  near(only(sim(oneDay(hit, 100, 120), { side: 'short', tp: 0.5, buffer: 0.125 })), 0.5);
  const near_ = [[101, 43.7501], [101, 99], [101, 99], [101, 99]];
  near(only(sim(oneDay(near_, 100, 120), { side: 'short', tp: 0.5, buffer: 0.125 })), -0.2);
});

test('合格判定: 八個條件各自單獨不成立時都不合格,只有「個股達標(D3)」對兩倍成本與 5 分 K 不要求', async () => {
  const { isQualified } = await import('../site/js/engine/intraday.js');
  const T = { winThreshold: 0.8, meanThreshold: 0.01, passShare: 0.5 };
  const good = () => ({ live: true, i2: { win: 0.9, mean: 0.02, stockPass: 0.7 }, i2x2: { win: 0.85, mean: 0.015, stockPass: 0.1 }, m5: { win: 0.85, mean: 0.015, stockPass: 0.1 } });
  assert.equal(isQualified(good(), T), true, '兩倍成本與 5 分 K 的個股達標很低也沒關係');
  const breaks = {
    '不是存活候選': (c) => { c.live = false; },
    'I2 勝率': (c) => { c.i2.win = 0.8; }, 'I2 平均': (c) => { c.i2.mean = 0.0099; }, 'I2 個股達標': (c) => { c.i2.stockPass = 0.5; },
    '兩倍成本勝率': (c) => { c.i2x2.win = 0.8; }, '兩倍成本平均': (c) => { c.i2x2.mean = 0.0099; },
    '5 分 K 勝率': (c) => { c.m5.win = 0.8; }, '5 分 K 平均': (c) => { c.m5.mean = 0.0099; },
  };
  for (const [label, brk] of Object.entries(breaks)) {
    const c = good(); brk(c);
    assert.equal(isQualified(c, T), false, label);
  }
});

test('盤中檔格式錯誤: 給出看得懂的訊息', async () => {
  const { readFileSync } = await import('node:fs');
  const { intradayFromNpz } = await import('../site/js/engine/npz.js');
  const load = (name) => { const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url)); return intradayFromNpz(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const ok = await load('intraday_ok_small.npz');
  assert.equal(ok.nb, 4); assert.equal(ok.m, 2); assert.deepEqual(ok.tickers, ['A', 'B']); assert.equal(ok.dates.length, 3);
  await assert.rejects(load('intraday_badshape.npz'), /L 的形狀 \(3, 3, 2\) 與 H \(3, 4, 2\) 不同/);
  await assert.rejects(load('intraday_badoc.npz'), /O 的形狀應該是 \(3, 2\),實際是 \(3, 1\)/);
  await assert.rejects(load('intraday_unsorted.npz'), /dates 必須由舊到新/);
  await assert.rejects(load('intraday_badtickers.npz'), /tickers 有 3 檔,但 H 有 2 檔/);
  await assert.rejects(load('intraday_missing.npz'), /缺少陣列: C/);
  await assert.rejects(load('intraday_flat.npz'), /H 的形狀應該是 \(3, 第幾根, 檔數\)/);
});
