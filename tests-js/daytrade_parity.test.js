// 一致性: 當沖引擎(JS) vs 使用者研究程式裡的 Python 實作(lab/daytrade.py 的 build_panel / load_panel / grid / trades / stats)。
// 標準答案(fixtures/daytrade_golden*.json)是用他的程式在 fixtures/daytrade_panel*.npz 上算出來的;
// 面板是亂數合成的行情(含晚上市、下市、一字線、高低價矛盾、非正價格),只用來比對算法,不代表真實行情。
// 他的程式本身不在這個 repo。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { compileGrid, evaluateRules, frontier, pickCandidates, splitSegments, standardGrid, summarize } from '../site/js/engine/daytrade.js';
import { panelFromNpz } from '../site/js/engine/npz.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const asBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const close = (a, b, label) => {
  const tol = 1e-9 * Math.max(1, Math.abs(b));
  assert.ok(Math.abs(a - b) <= tol, `${label}: JS ${a} vs Python ${b}`);
};

/** Python 的 stats() 輸出(snake_case)對 JS 的(camelCase) */
function compareStats(js, py, label) {
  assert.equal(js.n, py.n, `${label} n`);
  assert.equal(js.days, py.days, `${label} days`);
  for (const [a, b] of [['win', 'win'], ['mean', 'mean'], ['median', 'median'], ['avgWin', 'avg_win'], ['avgLoss', 'avg_loss'], ['dayMean', 'day_mean'], ['elig', 'elig'], ['stockPass', 'stock_pass']]) {
    close(js[a], py[b], `${label} ${a}`);
  }
}

async function setup(panelFile, goldenFile, { devMin, holdMin }) {
  const panel = await panelFromNpz(asBuffer(fixture(panelFile)));
  const golden = JSON.parse(fixture(goldenFile).toString('utf8'));
  const { ok, errors, compiled } = compileGrid(standardGrid());
  assert.ok(ok, JSON.stringify(errors));
  const segments = splitSegments(panel, golden.holdout_start, { devMinTrades: devMin, holdoutMinTrades: holdMin });
  return { panel, golden, compiled, segments };
}

test('讀取 .npz: 日曆、代號、形狀與使用者的程式一致', async () => {
  const { panel, golden } = await setup('daytrade_panel.npz', 'daytrade_golden.json', { devMin: 5, holdMin: 2 });
  assert.deepEqual(panel.tickers, golden.tickers);
  assert.equal(panel.dates.length, golden.n_days);
  assert.equal(panel.dates[0], golden.first_date);
  assert.equal(panel.dates.at(-1), golden.last_date);
  assert.ok(panel.aux['^VIX'] instanceof Float64Array && panel.aux['^VIX'].length === golden.n_days);
  assert.ok(panel.o.every((c) => c instanceof Float32Array && c.length === golden.n_days));
  assert.ok(panel.o[0].slice(0, 250).every(Number.isNaN), '晚上市的標的前面是 NaN');
});

test('588 條規則: 開發集與 holdout 的每一項統計都與 Python 相同(保守、樂觀、2 倍成本)', async () => {
  const { panel, golden, compiled, segments } = await setup('daytrade_panel.npz', 'daytrade_golden.json', { devMin: 5, holdMin: 2 });
  const out = evaluateRules(panel, compiled, { segments, variants: ['cons', 'opt', 'cost2x'], median: true, daily: true });
  assert.equal(out.rules.length, 588);
  assert.deepEqual(out.rules.map((r) => r.key), golden.rules.map((r) => r.rule), '規則順序與名稱和他的 grid() / name() 相同');
  out.rules.forEach((r, i) => {
    const py = golden.rules[i];
    compareStats(r.stats.cons.dev, py.dev_cons, `${r.key} dev 保守`);
    compareStats(r.stats.cons.holdout, py.hold_cons, `${r.key} holdout 保守`);
    compareStats(r.stats.opt.dev, py.dev_opt, `${r.key} dev 樂觀`);
    compareStats(r.stats.opt.holdout, py.hold_opt, `${r.key} holdout 樂觀`);
    compareStats(r.stats.cost2x.holdout, py.hold_2x, `${r.key} holdout 2 倍成本`);
  });
  // 這份合成資料要有足夠的覆蓋,否則「全部相同」沒有意義
  assert.ok(out.rules.filter((r) => r.stats.cons.dev.n > 0).length >= 550);
  assert.ok(out.rules.filter((r) => r.stats.opt.dev.win > 0.8 && r.stats.opt.dev.n > 20).length >= 100, '樂觀算法下勝率偏高的規則(限價 + 停利)要有');
  const differ = out.rules.filter((r) => r.stats.opt.dev.mean !== r.stats.cons.dev.mean).length;
  assert.ok(differ >= 100, `樂觀與保守要真的不同(${differ})`);
});

test('個股各自達標的比例(門檻可調)與 Python 相同', async () => {
  const { panel, golden, compiled, segments } = await setup('daytrade_panel.npz', 'daytrade_golden.json', { devMin: 5, holdMin: 2 });
  const out = evaluateRules(panel, compiled, { segments: segments.slice(0, 1), variants: ['cons'], thresholds: { winThreshold: 0.55, meanThreshold: 0.0005 } });
  let positive = 0;
  out.rules.forEach((r, i) => {
    close(r.stats.cons.dev.stockPass, golden.rules[i].dev_cons_loose_stock_pass, `${r.key} stockPass`);
    if (r.stats.cons.dev.stockPass > 0) positive++;
  });
  assert.ok(positive >= 50, `要有不少規則的 stockPass > 0 才有比對意義(${positive})`);
});

test('標的中間缺值(停牌、缺資料)的面板: 不用 RSI 的規則逐項相同', async () => {
  const { panel, golden, compiled, segments } = await setup('daytrade_panel_gaps.npz', 'daytrade_golden_gaps.json', { devMin: 5, holdMin: 2 });
  const out = evaluateRules(panel, compiled, { segments, variants: ['cons'], median: true, daily: true });
  let checked = 0, rsiRules = 0;
  out.rules.forEach((r, i) => {
    if (r.setup.startsWith('rsi2') || r.setup.startsWith('up200&rsi2')) { rsiRules++; return; }
    compareStats(r.stats.cons.dev, golden.rules[i].dev_cons, `${r.key} dev`);
    compareStats(r.stats.cons.holdout, golden.rules[i].hold_cons, `${r.key} holdout`);
    checked++;
  });
  assert.ok(checked >= 450 && rsiRules > 0);
});

test('標的中間缺值: RSI 規則只在缺值附近有微小差異(交易筆數差不到 1%)', async () => {
  // Python 的指數平滑遇到缺值會「按時間衰減權重」,這裡跳過缺值,兩者在缺值後幾根內會有差別;其他地方相同
  const { panel, golden, compiled, segments } = await setup('daytrade_panel_gaps.npz', 'daytrade_golden_gaps.json', { devMin: 5, holdMin: 2 });
  const out = evaluateRules(panel, compiled, { segments, variants: ['cons'] });
  let compared = 0;
  out.rules.forEach((r, i) => {
    if (!(r.setup.startsWith('rsi2') || r.setup.startsWith('up200&rsi2'))) return;
    const js = r.stats.cons.dev, py = golden.rules[i].dev_cons;
    if (py.n < 100) return;
    assert.ok(Math.abs(js.n - py.n) / py.n < 0.01, `${r.key}: JS ${js.n} vs Python ${py.n}`);
    assert.ok(Math.abs(js.win - py.win) < 0.01, `${r.key} win`);
    compared++;
  });
  assert.ok(compared >= 10);
});

test('候選、可行邊界、通過數統計: 與使用者的 run_daytrade.py 相同', async () => {
  const { panel, golden, compiled, segments } = await setup('daytrade_panel.npz', 'daytrade_golden.json', { devMin: 5, holdMin: 2 });
  const out = evaluateRules(panel, compiled, { segments: segments.slice(0, 1), variants: ['cons', 'opt'] });
  const views = { dev: (r) => r.stats.cons.dev, dev_optimistic: (r) => r.stats.opt.dev };
  for (const [key, get] of Object.entries(views)) {
    const py = golden.selection[key];
    assert.deepEqual(pickCandidates(out.rules, get), py.candidates, `${key} 候選`);
    assert.deepEqual(summarize(out.rules, get), py.counts, `${key} 通過數`);

    // 他的 frontier() 是印出文字: 「勝率≥55% 平均最高 <規則名> …」與「平均≥0.25% 勝率最高 <規則名> …」
    const lines = py.frontier.split('\n');
    const f = frontier(out.rules, get);
    const pyWin = lines.map((x) => /^勝率≥(\d+)% 平均最高 (\S+)/.exec(x)).filter(Boolean).map((m) => ({ threshold: Number(m[1]) / 100, key: m[2] }));
    const pyMean = lines.map((x) => /^平均≥([\d.]+)% 勝率最高 (\S+)/.exec(x)).filter(Boolean).map((m) => ({ threshold: Number(m[1]) / 100, key: m[2] }));
    assert.deepEqual(f.byWin.map((x) => ({ threshold: Math.round(x.threshold * 100) / 100, key: x.key })), pyWin, `${key} 勝率邊界`);
    assert.deepEqual(f.byMean.map((x) => ({ threshold: Math.round(x.threshold * 1e4) / 1e4, key: x.key })), pyMean, `${key} 平均邊界`);
    assert.equal(f.eligible, Number(/的 (\d+) 條/.exec(py.frontier)[1]), `${key} 可用規則數`);
  }
  // 樂觀算法下通過的規則是假象(限價 + 停利: 最高價在成交之前),保守算法下一條都不會過
  assert.ok(summarize(out.rules, views.dev_optimistic).all > 0 && summarize(out.rules, views.dev).all === 0);
});
