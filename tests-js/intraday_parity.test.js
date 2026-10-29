// 一致性: 盤中 K 線驗證(JS) vs 使用者研究程式裡的 Python 實作
//   lab/daytrade.py 的 load_intraday / trades_intraday / stats,以及 run_daytrade.py 的 intraday() 程序。
// 標準答案(fixtures/intraday_golden.json)是用他的程式在 fixtures/intraday_60m.npz、intraday_5m.npz(搭配
// daytrade_panel.npz 這份日線)上算出來的。盤中資料是亂數合成的(含缺棒、整天缺資料、開收缺值、不在日線日曆上的日期),
// 只用來比對算法,不代表真實行情。他的程式本身不在這個 repo。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileGrid, frontier, pickCandidates, standardGrid, summarize } from '../site/js/engine/daytrade.js';
import {
  alignIntraday, allDaysSegment, confirmKeys, evaluateIntraday, halfSegments, isLive, isQualified,
} from '../site/js/engine/intraday.js';
import { intradayFromNpz, panelFromNpz } from '../site/js/engine/npz.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const asBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const golden = JSON.parse(fixture('intraday_golden.json').toString('utf8'));

const close = (a, b, label) => {
  const tol = 1e-9 * Math.max(1, Math.abs(b));
  assert.ok(Math.abs(a - b) <= tol, `${label}: JS ${a} vs Python ${b}`);
};
/** golden 裡的統計是欄位陣列(順序在 golden.fields),轉成 JS 的 stats 物件的鍵 */
const KEY = { n: 'n', days: 'days', win: 'win', mean: 'mean', median: 'median', avg_win: 'avgWin', avg_loss: 'avgLoss', day_mean: 'dayMean', elig: 'elig', stock_pass: 'stockPass' };
function compareStats(js, packed, label) {
  golden.fields.forEach((f, i) => {
    if (f === 'n' || f === 'days') assert.equal(js[KEY[f]], packed[i], `${label} ${f}`);
    else close(js[KEY[f]], packed[i], `${label} ${f}`);
  });
}
const unpack = (packed) => Object.fromEntries(golden.fields.map((f, i) => [KEY[f], packed[i]]));

let cache;
async function setup() {
  if (cache) return cache;
  const panel = await panelFromNpz(asBuffer(fixture('daytrade_panel.npz')));
  const i60 = await intradayFromNpz(asBuffer(fixture('intraday_60m.npz')));
  const i5 = await intradayFromNpz(asBuffer(fixture('intraday_5m.npz')));
  const a60 = alignIntraday(panel, i60), a5 = alignIntraday(panel, i5);
  const { ok, errors, compiled } = compileGrid(standardGrid());
  assert.ok(ok, JSON.stringify(errors));
  cache = { panel, i60, i5, a60, a5, compiled };
  return cache;
}

const LOOSE = { winThreshold: 0.6, meanThreshold: 0.002 };

test('讀取盤中 .npz: 形狀、日期與使用者的程式一致,不在日線日曆上的日期被略過', async () => {
  const { panel, i60, i5, a60, a5 } = await setup();
  assert.equal(i60.nb, golden.nb60);
  assert.equal(i5.nb, golden.nb5);
  assert.equal(i60.m, golden.tickers.length);
  assert.ok(i60.H instanceof Float32Array && i60.O instanceof Float32Array);
  assert.equal(i60.dates.length, golden.n60 + 2, '檔裡多了兩個不在日線日曆上的日期(一個週六、一個面板結束之後)');
  assert.equal(i5.dates.length, golden.n5 + 1);
  assert.deepEqual(a60.dates, golden.dates60);
  assert.deepEqual(a5.dates, golden.dates5);
  assert.equal(a60.skippedDates, 2);
  assert.equal(a5.skippedDates, 1);
  assert.equal(a60.matched, 14);
  assert.ok(a60.dates.every((d) => panel.dates.includes(d)));
  assert.equal(Math.floor(a60.n / 2), golden.half);
});

test('588 條規則: 60 分 K 的 I1 / I2(保守、樂觀、2 倍成本)每一項統計都與 Python 相同', async () => {
  const { panel, a60, compiled } = await setup();
  const out = evaluateIntraday(panel, a60, compiled, { segments: halfSegments(a60.n), variants: ['cons', 'opt', 'cost2x'], median: true });
  assert.equal(out.rules.length, 588);
  assert.deepEqual(out.rules.map((r) => r.key), golden.rules.map((r) => r.rule), '規則順序與名稱和他的 grid() / name() 相同');
  out.rules.forEach((r, i) => {
    const py = golden.rules[i];
    compareStats(r.stats.cons.i1, py.i1, `${r.key} I1 保守`);
    compareStats(r.stats.opt.i1, py.i1_opt, `${r.key} I1 樂觀`);
    compareStats(r.stats.cons.i2, py.i2, `${r.key} I2 保守`);
    compareStats(r.stats.opt.i2, py.i2_opt, `${r.key} I2 樂觀`);
    compareStats(r.stats.cost2x.i2, py.i2_2x, `${r.key} I2 2 倍成本`);
  });
  // 覆蓋: 要有足夠多有交易的規則,而且樂觀與保守要真的不同(成交與停利出現在同一根 K 棒的情形)
  assert.ok(out.rules.filter((r) => r.stats.cons.i1.n > 0).length >= 400);
  assert.ok(out.rules.filter((r) => r.stats.opt.i1.mean !== r.stats.cons.i1.mean).length >= 150);
});

test('588 條規則: 5 分 K(全部交易日,保守與樂觀)與 Python 相同', async () => {
  const { panel, a5, compiled } = await setup();
  const out = evaluateIntraday(panel, a5, compiled, { segments: allDaysSegment(a5.n), variants: ['cons', 'opt'], median: true });
  out.rules.forEach((r, i) => {
    compareStats(r.stats.cons.all, golden.rules[i].m5, `${r.key} 5 分 K 保守`);
    compareStats(r.stats.opt.all, golden.rules[i].m5_opt, `${r.key} 5 分 K 樂觀`);
  });
  assert.ok(out.rules.filter((r) => r.stats.cons.all.n > 0).length >= 400);
});

test('不算 median / 逐日統計時,其餘欄位不受影響', async () => {
  const { panel, a60, compiled } = await setup();
  const out = evaluateIntraday(panel, a60, compiled, { segments: halfSegments(a60.n).slice(0, 1), variants: ['cons'], ruleKeys: ['long|none|lim1atr|tp1%', 'short|none|open|close'] });
  assert.equal(out.rules.length, 2);
  for (const r of out.rules) {
    const py = golden.rules.find((x) => x.rule === r.key).i1;
    assert.equal(r.stats.cons.i1.n, py[0]);
    close(r.stats.cons.i1.mean, py[3], `${r.key} mean`);
    assert.equal(r.stats.cons.i1.median, 0, 'median 沒開就是 0');
  }
});

/** 他的 run_daytrade.intraday() 兩組門檻的完整程序: 掃描(I1)→ 存活候選 → --confirm(I2 與 5 分 K) */
for (const tag of ['strict', 'loose']) {
  test(`${tag === 'strict' ? '他的原始門檻' : '放寬的門檻'}: 存活候選、候選、通過數、可行邊界、確認階段與合格判定都與 run_daytrade.py 相同`, async () => {
    const { panel, a60, a5, compiled } = await setup();
    const py = golden.protocols[tag];
    const thr = tag === 'loose' ? { ...LOOSE } : {};
    const T = { winThreshold: py.win, meanThreshold: py.ret, passShare: 0.5, eligShare: 0.5 };
    const segs = halfSegments(a60.n);

    // 掃描: 只算 I1 的保守與樂觀
    const scan = evaluateIntraday(panel, a60, compiled, { segments: segs.slice(0, 1), variants: ['cons', 'opt'], thresholds: thr });
    assert.deepEqual([a60.dates[0], a60.dates[golden.half - 1]], py.i1_range);
    assert.deepEqual([a60.dates[golden.half], a60.dates.at(-1)], py.i2_range);
    scan.rules.forEach((r, i) => {
      close(r.stats.cons.i1.stockPass, tag === 'loose' ? py.i1_stock_pass[i] : golden.rules[i].i1[9], `${r.key} I1 stockPass`);
      close(r.stats.opt.i1.stockPass, tag === 'loose' ? py.i1_opt_stock_pass[i] : golden.rules[i].i1_opt[9], `${r.key} I1 樂觀 stockPass`);
    });
    const cons = (r) => r.stats.cons.i1, opt = (r) => r.stats.opt.i1;
    const live = scan.rules.filter((r) => isLive(opt(r), T)).map((r) => r.key);
    assert.deepEqual(live, py.live, '存活候選(I1 樂觀上界過 D1 與 D2)');
    const cands = pickCandidates(scan.rules, cons, T);
    assert.deepEqual(cands, py.candidates, 'I1 的候選');

    // 印出的第一、二行: 「[i1] 588 條中 H1 過 x、H2 過 y、H1+H2 同時過 z、H3 過 w、全過 v」
    for (const [key, get] of [['i1', cons], ['i1_optimistic', opt]]) {
      const m = new RegExp(`\\[${key}\\] 588 條中 H1 過 (\\d+)、H2 過 (\\d+)、H1\\+H2 同時過 (\\d+)、H3 過 (\\d+)、全過 (\\d+)`).exec(py.scan_text);
      const s = summarize(scan.rules, get, T);
      assert.deepEqual([s.D1, s.D2, s.D1D2, s.D3, s.all], m.slice(1).map(Number), `${key} 通過數`);
    }
    const f = frontier(scan.rules, cons, T), lines = py.scan_text.split('\n');
    const pyWin = lines.map((x) => /^勝率≥(\d+)% 平均最高 (\S+)/.exec(x)).filter(Boolean).map((m) => ({ threshold: Number(m[1]) / 100, key: m[2] }));
    const pyMean = lines.map((x) => /^平均≥([\d.]+)% 勝率最高 (\S+)/.exec(x)).filter(Boolean).map((m) => ({ threshold: Number(m[1]) / 100, key: m[2] }));
    assert.deepEqual(f.byWin.map((x) => ({ threshold: Math.round(x.threshold * 100) / 100, key: x.key })), pyWin, '勝率邊界');
    assert.deepEqual(f.byMean.map((x) => ({ threshold: Math.round(x.threshold * 1e4) / 1e4, key: x.key })), pyMean, '平均邊界');
    assert.equal(f.eligible, Number(/的 (\d+) 條/.exec(py.scan_text)[1]), '可用規則數');

    // 確認: 存活候選 + 候選,I2(保守、樂觀、2 倍成本)與 5 分 K(保守、樂觀)
    const keys = confirmKeys(live, cands);
    assert.deepEqual(keys, py.confirm_order, '確認階段要看的規則與順序');
    const c60 = evaluateIntraday(panel, a60, compiled, { segments: segs.slice(1), variants: ['cons', 'opt', 'cost2x'], ruleKeys: keys, thresholds: thr, median: true });
    const c5 = evaluateIntraday(panel, a5, compiled, { segments: allDaysSegment(a5.n), variants: ['cons', 'opt'], ruleKeys: keys, thresholds: thr, median: true });
    const by60 = new Map(c60.rules.map((r) => [r.key, r])), by5 = new Map(c5.rules.map((r) => [r.key, r]));
    let qualified = 0;
    for (const k of keys) {
      const want = py.confirm[k], r60 = by60.get(k), r5 = by5.get(k);
      compareStats(r60.stats.cons.i2, want.i2, `${k} I2 保守`);
      compareStats(r60.stats.opt.i2, want.i2_opt, `${k} I2 樂觀`);
      compareStats(r60.stats.cost2x.i2, want.i2_2x, `${k} I2 2 倍成本`);
      compareStats(r5.stats.cons.all, want.m5, `${k} 5 分 K 保守`);
      compareStats(r5.stats.opt.all, want.m5_opt, `${k} 5 分 K 樂觀`);
      const isLiveKey = live.includes(k);
      assert.equal(isLiveKey, want.live, `${k} live`);
      const q = isQualified({ live: isLiveKey, i2: r60.stats.cons.i2, i2x2: r60.stats.cost2x.i2, m5: r5.stats.cons.all }, T);
      assert.equal(q, want.qualified, `${k} 合格判定`);
      if (q) qualified++;
    }
    if (tag === 'loose') assert.ok(qualified >= 5, `放寬門檻下要有合格的規則才有比對力道(${qualified})`);
    assert.equal(qualified, Object.values(py.confirm).filter((c) => c.qualified).length);
    assert.ok(keys.length >= 3);
  });
}

test('合格判定: 600 組隨機統計值(含剛好在門檻上)與他的判斷式相同', () => {
  const T = { winThreshold: 0.8, meanThreshold: 0.01, passShare: 0.5 };
  const camel = (s) => ({ win: s.win, mean: s.mean, stockPass: s.stock_pass });
  let yes = 0, no = 0;
  for (const { c, qualified } of golden.qualified_table) {
    assert.equal(isQualified({ live: c.live, i2: camel(c.i2), i2x2: camel(c.i2_2x_cost), m5: camel(c.m5) }, T), qualified, JSON.stringify(c));
    if (qualified) yes++; else no++;
  }
  assert.ok(yes >= 50 && no >= 50, `兩種結果都要有(${yes}/${no})`);
});

test('存活候選的判斷: 剛好在門檻上不算過(勝率是「>」、平均是「≥」)', () => {
  const T = { winThreshold: 0.8, meanThreshold: 0.01 };
  assert.equal(isLive({ win: 0.8, mean: 0.02 }, T), false);
  assert.equal(isLive({ win: 0.8001, mean: 0.01 }, T), true);
  assert.equal(isLive({ win: 0.9, mean: 0.0099999 }, T), false);
});

test('盤中檔沒有存代號時,檔數必須和日線面板一致;有代號時依代號對齊', async () => {
  const { panel, i60 } = await setup();
  assert.throws(() => alignIntraday(panel, { ...i60, m: 13 }), /盤中檔有 13 檔,日線面板有 14 檔/);
  const named = alignIntraday(panel, { ...i60, tickers: [...panel.tickers].reverse() });
  assert.deepEqual([...named.column], panel.tickers.map((_, k) => panel.tickers.length - 1 - k));
  const partial = alignIntraday(panel, { ...i60, tickers: panel.tickers.map((t, i) => (i === 3 ? 'ZZZ' : t)) });
  assert.equal(partial.column[3], -1);
  assert.equal(partial.matched, 13);
  assert.throws(() => alignIntraday({ ...panel, dates: ['1999-01-01'] }, i60), /沒有任何交集/);
});
