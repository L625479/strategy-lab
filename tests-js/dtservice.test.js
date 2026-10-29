import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { emptyGrid, panelFromBars, standardGrid, summarizeTrace } from '../site/js/engine/daytrade.js';
import { createService } from '../site/js/engine/dtService.js';
import { randomWalk } from './helpers.js';

const asBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const golden = JSON.parse(readFileSync(new URL('./fixtures/daytrade_golden.json', import.meta.url), 'utf8'));
const buffer = () => asBuffer(readFileSync(new URL('./fixtures/daytrade_panel.npz', import.meta.url)));
const cfg = (extra = {}) => ({ grid: standardGrid(), splitDate: golden.holdout_start, devMinTrades: 5, holdoutMinTrades: 2, optimistic: true, ...extra });

test('服務: 載入 → 掃描 → 結果與 Python 的開發集統計相同,且只含開發集', async () => {
  const svc = createService();
  const info = await svc.loadNpz({ buffer: buffer() });
  assert.equal(info.tickers, 14); assert.equal(info.days, 1300); assert.deepEqual(info.aux, ['^VIX']);
  const progress = [];
  const out = svc.scan(cfg(), (d, t) => progress.push([d, t]));
  assert.equal(out.rules.length, 588);
  assert.deepEqual(progress.at(-1), [14, 14]);
  assert.ok(out.dev.last < golden.holdout_start && out.dev.first === golden.first_date);
  out.rules.forEach((r, i) => {
    assert.equal(r.key, golden.rules[i].rule);
    assert.equal(r.cons.n, golden.rules[i].dev_cons.n);
    assert.equal(r.opt.n, golden.rules[i].dev_opt.n);
  });
  assert.equal(svc.scan(cfg({ optimistic: false })).rules[0].opt, null);
});

test('服務: holdout 只算指定的規則,三種變體', async () => {
  const svc = createService();
  await svc.loadNpz({ buffer: buffer() });
  const keys = ['long|gap<=-1atr|open|tp1%', 'short|none|open|close'];
  const out = svc.holdout(cfg({ keys }));
  assert.deepEqual(out.rules.map((r) => r.key), keys);
  for (const r of out.rules) {
    const py = golden.rules.find((g) => g.rule === r.key);
    assert.equal(r.cons.n, py.hold_cons.n); assert.equal(r.opt.n, py.hold_opt.n); assert.equal(r.cost2x.n, py.hold_2x.n);
  }
  assert.ok(out.holdout.first >= golden.holdout_start);
});

test('服務: 明細(逐檔、逐年、分佈)與統計一致,開發集明細看不到 holdout', async () => {
  const svc = createService();
  await svc.loadNpz({ buffer: buffer() });
  const key = 'long|none|open|close';
  const scan = svc.scan(cfg()).rules.find((r) => r.key === key).cons;
  const d = svc.detail(cfg({ key }));
  assert.equal(d.perTicker.reduce((a, x) => a + x.n, 0), scan.n);
  assert.equal(d.perYear.reduce((a, x) => a + x.n, 0), scan.n);
  assert.equal(d.overall.n, scan.n);
  assert.ok(Math.abs(d.overall.win - scan.win) < 1e-12 && Math.abs(d.overall.mean - scan.mean) < 1e-12);
  assert.equal(d.hist.counts.reduce((a, b) => a + b, 0) + d.hist.under + d.hist.over, scan.n);
  assert.ok(d.perYear.at(-1).year <= golden.holdout_start.slice(0, 4));
  const hold = svc.detail(cfg({ key, segment: 'holdout' }));
  assert.ok(hold.perYear[0].year >= golden.holdout_start.slice(0, 4));
});

test('服務: 錯誤情況', async () => {
  const svc = createService();
  assert.throws(() => svc.scan(cfg()), /還沒有載入資料/);
  assert.equal(svc.info(), null);
  await svc.loadNpz({ buffer: buffer() });
  assert.throws(() => svc.scan(cfg({ grid: { ...emptyGrid(), setups: [{ side: 'long', name: 'x', expr: 'close >' }] } })), /規則有 1 個問題/);
  assert.throws(() => svc.scan(cfg({ splitDate: '1999-01-01' })), /開發集裡沒有任何資料/);
  assert.throws(() => svc.loadBars({ entries: [] }), /至少選一檔/);
  await assert.rejects(svc.loadNpz({ buffer: new ArrayBuffer(8) }), /npz/);
});

test('服務: 從 bars 載入(內建標的 / CSV 路徑),含外部序列', () => {
  const svc = createService();
  const a = randomWalk(300, 1, 0.02), b = randomWalk(300, 2, 0.02);
  const vix = { d: a.d, c: Float64Array.from({ length: 300 }, (_, i) => 15 + (i % 40)) };
  const info = svc.loadBars({ entries: [{ id: 'A', bars: a }, { id: 'B', bars: b }], aux: { '^VIX': vix } });
  assert.deepEqual([info.tickers, info.days, info.aux], [2, 300, ['^VIX']]);
  const out = svc.scan({ grid: standardGrid(), splitDate: a.d[220], thresholds: {}, devMinTrades: 5 });
  assert.equal(out.rules.length, 588);
  assert.ok(out.rules.some((r) => r.setup === 'vix>30' && r.cons.n > 0), 'vix 條件有觸發');
});

test('summarizeTrace: 逐檔與逐年加總、分佈區間與尾端', () => {
  const panel = panelFromBars([{ id: 'A', bars: randomWalk(60, 3) }, { id: 'B', bars: randomWalk(60, 4) }]);
  const trace = { tickerIdx: Int32Array.from([0, 0, 1, 1]), dayIdx: Int32Array.from([1, 2, 3, 59]), net: Float64Array.from([0.05, -0.2, 0.3, 0.0]) };
  const s = summarizeTrace(panel, trace, { histLo: -0.1, histHi: 0.1, bins: 4 });
  assert.deepEqual(s.perTicker.map((x) => [x.id, x.n, x.win]), [['A', 2, 0.5], ['B', 2, 0.5]]);
  const want = { n: 4, win: 0.5, mean: 0.0375, median: 0.025, avgWin: 0.175, avgLoss: -0.1 };                  // 0.0 不算贏
  for (const [k, v] of Object.entries(want)) assert.ok(Math.abs(s.overall[k] - v) < 1e-12, `${k}: ${s.overall[k]} vs ${v}`);
  assert.equal(s.perYear.reduce((a, x) => a + x.n, 0), 4);
  assert.deepEqual(s.hist.counts, [0, 0, 1, 1]);                  // 0.0 → 第 3 格、+5% → 第 4 格
  assert.equal(s.hist.under, 1); assert.equal(s.hist.over, 1);
});

test('服務: 之後再補外部序列(setAux),對齊到面板日曆並用前值填補', () => {
  const svc = createService();
  const a = randomWalk(120, 1, 0.02);
  svc.loadBars({ entries: [{ id: 'A', bars: a }] });
  assert.throws(() => createService().setAux({ aux: {} }), /還沒有載入資料/);
  const info = svc.setAux({ aux: { '^VIX': { d: [a.d[0], a.d[50]], c: Float64Array.from([20, 45]) } } });
  assert.deepEqual(info.aux, ['^VIX']);
  const grid = { ...emptyGrid(), aux: [{ name: 'vix', ticker: '^VIX' }], setups: [{ side: 'long', name: 'v', expr: 'vix > 30' }] };
  const out = svc.scan({ grid, splitDate: a.d[100], devMinTrades: 1 }).rules[0].cons;
  assert.ok(out.n > 0 && out.n <= 50, `vix 從第 50 天起 > 30(前一日收盤),第 51~99 天可交易: ${out.n}`);
});
