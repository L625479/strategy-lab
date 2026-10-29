import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCsv, staleCloseShare, toBars } from '../site/js/engine/data.js';
import {
  TEMPLATES, compileStrategy, computeSignals, decodeShare, emptyStrategy, encodeShare, normalizeStrategy,
} from '../site/js/engine/strategy.js';
import { randomWalk } from './helpers.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const withPatch = (patch) => ({ ...emptyStrategy(), ...patch });
const fields = (r) => r.errors.map((e) => e.field);

test('所有範本都能編譯、能在真實長度的資料上算出訊號,且至少會產生交易', async () => {
  const { runBacktest } = await import('../site/js/engine/backtest.js');
  const bars = randomWalk(1500, 5, 0.018);
  for (const t of TEMPLATES) {
    const r = compileStrategy(t.strategy);
    assert.ok(r.ok, `${t.id}: ${r.errors.map((e) => e.message).join('; ')}`);
    const signals = computeSignals(r.compiled, bars);
    const bt = runBacktest({ bars, signals, strategy: r.compiled.strategy, capital: 10000 });
    assert.ok(bt.trades.length + (bt.openPosition ? 1 : 0) >= 1, `${t.id} 沒有任何交易`);
  }
});

test('驗證: 錯誤對應到具體欄位', () => {
  const r = compileStrategy(withPatch({
    params: [{ name: 'fast', value: 5 }, { name: 'fast', value: 6 }, { name: '9x', value: 1 }, { name: 'and', value: 1 }, { name: 'close', value: 1 }],
    indicators: [{ name: 'a', expr: 'sma(close, nope)' }, { name: 'b', expr: 'sma(close' }, { name: 'c', expr: 'magic(close, 3)' }],
    entry: { long: 'a > zzz', short: '' },   // a 有定義(即使它的運算式是壞的),zzz 沒有
  }));
  assert.equal(r.ok, false);
  const f = fields(r);
  for (const want of ['params[1].name', 'params[2].name', 'params[3].name', 'params[4].name', 'indicators[0].expr', 'indicators[1].expr', 'indicators[2].expr', 'entry.long']) {
    assert.ok(f.includes(want), `缺少欄位 ${want}: ${f}`);
  }
});

test('驗證: 指標只能引用「前面」的指標與參數', () => {
  const ok = compileStrategy(withPatch({ indicators: [{ name: 'a', expr: 'sma(close, 5)' }, { name: 'b', expr: 'a * 2' }], entry: { long: 'b > a', short: '' } }));
  assert.ok(ok.ok);
  const bad = compileStrategy(withPatch({ indicators: [{ name: 'b', expr: 'a * 2' }, { name: 'a', expr: 'sma(close, 5)' }], entry: { long: 'b > a', short: '' } }));
  assert.ok(fields(bad).includes('indicators[0].expr'));
});

test('驗證: 進場條件、做空、止損止盈、倉位、成本', () => {
  assert.ok(fields(compileStrategy(withPatch({ entry: { long: '', short: '' } }))).includes('entry.long'));
  assert.ok(compileStrategy(withPatch({ allowShort: true, entry: { long: '', short: 'close < 1' } })).ok);
  assert.ok(fields(compileStrategy(withPatch({ allowShort: true, entry: { long: '', short: '' } }))).includes('entry.long'));
  // 沒開做空時,做空欄位裡就算是壞的也被忽略
  assert.ok(compileStrategy(withPatch({ entry: { long: 'true', short: '))))' } })).ok);

  const stop = (stopLoss) => fields(compileStrategy(withPatch({ entry: { long: 'true', short: '' }, stopLoss })));
  assert.deepEqual(stop({ mode: 'pct', pct: 0, atrN: 14, atrMult: 2, expr: '' }), ['stopLoss']);
  assert.deepEqual(stop({ mode: 'pct', pct: 101, atrN: 14, atrMult: 2, expr: '' }), ['stopLoss']);
  assert.deepEqual(stop({ mode: 'atr', pct: 5, atrN: 0, atrMult: 2, expr: '' }), ['stopLoss']);
  assert.deepEqual(stop({ mode: 'expr', pct: 5, atrN: 14, atrMult: 2, expr: '' }), ['stopLoss']);
  assert.deepEqual(stop({ mode: 'expr', pct: 5, atrN: 14, atrMult: 2, expr: 'bogus' }), ['stopLoss']);
  assert.deepEqual(stop({ mode: 'atr', pct: 5, atrN: 14, atrMult: 2, expr: '' }), []);

  const bad = (patch) => fields(compileStrategy(withPatch({ entry: { long: 'true', short: '' }, ...patch })));
  assert.deepEqual(bad({ sizing: { pctEquity: 0 } }), ['sizing.pctEquity']);
  assert.deepEqual(bad({ costs: { commissionBps: -1, slippageBps: 5000 } }), ['costs.commissionBps', 'costs.slippageBps']);
  assert.deepEqual(bad({ warmupBars: -5 }), ['warmupBars']);
});

test('警告: 槓桿、沒有任何出場', () => {
  const lev = compileStrategy(withPatch({ entry: { long: 'true', short: '' }, sizing: { pctEquity: 200 } }));
  assert.ok(lev.ok && lev.warnings.some((w) => /槓桿/.test(w)));
  const noExit = compileStrategy(withPatch({ entry: { long: 'close > 1', short: '' } }));
  assert.ok(noExit.warnings.some((w) => /出場/.test(w)));
  assert.ok(!compileStrategy(withPatch({ entry: { long: 'true', short: '' } })).warnings.some((w) => /出場/.test(w))); // 買入持有不警告
});

test('normalizeStrategy: 缺的補預設,型別不對的丟掉,數量有上限', () => {
  const s = normalizeStrategy({
    name: 'x'.repeat(200), params: Array.from({ length: 100 }, (_, i) => ({ name: `p${i}`, value: i })),
    entry: { long: 5, short: null }, allowShort: 'yes', warmupBars: 'abc', stopLoss: { mode: 'drop table' }, costs: { commissionBps: Infinity },
    extra: { evil: true },
  });
  assert.equal(s.name.length, 40); assert.equal(s.params.length, 30);
  assert.equal(s.entry.long, ''); assert.equal(s.allowShort, false); assert.equal(s.warmupBars, 50);
  assert.equal(s.stopLoss.mode, 'none'); assert.equal(s.costs.commissionBps, 5);
  assert.equal('extra' in s, false);
  assert.deepEqual(normalizeStrategy(null), emptyStrategy());
  assert.deepEqual(normalizeStrategy(TEMPLATES[0].strategy), TEMPLATES[0].strategy); // 合法的策略不被改動
});

test('分享連結: 往返一致(含中文),亂碼與過長會被拒絕', () => {
  const payload = { strategy: { ...TEMPLATES[1].strategy, name: '我的 SMA 策略 🚀' }, ids: ['SPY', '2330.TW'] };
  assert.deepEqual(decodeShare(encodeShare(payload)), payload);
  assert.match(encodeShare(payload), /^[A-Za-z0-9_-]+$/); // URL 安全
  assert.throws(() => decodeShare('###'));
  assert.throws(() => decodeShare('x'.repeat(50000)), /太長/);
});

test('computeSignals: 暖機與 NaN 期間不會有有效訊號,停損序列為正數', () => {
  const r = compileStrategy(TEMPLATES[0].strategy); // EMA + RSI,ATR 止損止盈
  const bars = randomWalk(400, 3, 0.02);
  const s = computeSignals(r.compiled, bars);
  assert.equal(s.valid.slice(0, 50).some(Boolean), false);
  assert.ok(s.valid[300]);
  assert.ok(s.slPct[300] > 0 && s.tpPct[300] > s.slPct[300]); // 止盈是止損的 2 倍(風報比 1:2)
  assert.ok(Object.keys(s.ind).join() === 'ema_f,ema_s,rsi_v');
});

// ---- 資料 -------------------------------------------------------------------

const tvCsv = (rows) => `time,open,high,low,close,Volume\n${rows.join('\n')}`;
const mkRows = (n, f = (i) => [100 + i, 101 + i, 99 + i, 100.5 + i]) => Array.from({ length: n }, (_, i) => {
  const [o, h, l, c] = f(i);
  return `${1736121600 + i * 86400},${o},${h},${l},${c},1000`; // 2025-01-06 起
});

test('CSV: TradingView 風格(unix 秒)', () => {
  const { bars, issues, staleShare } = parseCsv(tvCsv(mkRows(40)));
  assert.equal(bars.n, 40); assert.equal(bars.d[0], '2025-01-06'); assert.equal(bars.d[39], '2025-02-14');
  assert.equal(bars.c[0], 100.5); assert.deepEqual([issues.skipped, issues.repaired, issues.duplicates], [0, 0, 0]);
  assert.equal(staleShare, 0);
});

test('CSV: Yahoo 風格(日期字串 + Adj Close)會換算成調整後價格', () => {
  const uniq = Array.from({ length: 35 }, (_, i) => `${new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10)},100,102,98,101,50.5,1000`);
  const { bars, issues } = parseCsv(`Date,Open,High,Low,Close,Adj Close,Volume\n${uniq.join('\n')}`);
  assert.ok(issues.adjusted); assert.equal(bars.c[0], 50.5);   // 收盤改用調整後收盤價
  near(bars.o[0], 100 * 0.5, 1e-9);                            // 開高低依同一比例(50.5/101)換算
  near(bars.h[0], 102 * 0.5, 1e-9);
});

test('CSV: 分號分隔、BOM、斜線日期、亂序、重複、壞列、OHLC 矛盾', () => {
  const lines = ['﻿date;open;high;low;close'];
  for (let i = 0; i < 40; i++) lines.push(`${new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10).replace(/-/g, '/')};100;103;97;101`);
  lines.push('2025/01/05;100;103;97;999');      // 重複日期,保留最後一筆
  lines.push('not-a-date;1;2;0.5;1.5');         // 壞日期
  lines.push('2025/03/01;100;abc;97;101');      // 壞數字
  lines.push('2025/03/02;100;99;101;100.5');    // high < low,high < open → 修正
  const first = lines.splice(1, 1)[0];          // 打亂順序
  lines.push(first);
  const { bars, issues } = parseCsv(lines.join('\n'));
  // 修正 2 次: 收盤 999 的重複列(收盤高於最高價)與 high < low 的那一列
  assert.deepEqual(issues, { skipped: 2, repaired: 2, duplicates: 1, adjusted: false });
  assert.equal(bars.n, 41); assert.equal(bars.d[0], '2025-01-01');
  assert.ok([...bars.d].every((d, i, a) => i === 0 || a[i - 1] < d)); // 嚴格遞增
  const k = bars.d.indexOf('2025-03-02');
  assert.ok(bars.h[k] >= Math.max(bars.o[k], bars.c[k]) && bars.l[k] <= Math.min(bars.o[k], bars.c[k]));
});

test('CSV: 過期收盤價(開收完全相同)的佔比被偵測出來', () => {
  const { staleShare } = parseCsv(tvCsv(mkRows(100, (i) => (i % 2 ? [100, 105, 95, 100] : [100, 105, 95, 101]))));
  assert.equal(staleShare, 0.5);
  assert.equal(staleCloseShare({ n: 1, o: [1], h: [1], l: [1], c: [1] }), 0); // 平盤佔位不算
});

test('CSV: 錯誤訊息', () => {
  assert.throws(() => parseCsv(''), /空/);
  assert.throws(() => parseCsv('a,b\n1,2'), /缺少欄位/);
  assert.throws(() => parseCsv(tvCsv(mkRows(10))), /至少需要 30 列/);
});

test('toBars 檢查欄位長度', () => {
  assert.throws(() => toBars({ d: ['2025-01-01'], o: [1], h: [1], l: [1], c: [] }), /格式不正確/);
  const b = toBars({ d: ['2025-01-01'], o: [1], h: [2], l: [0.5], c: [1.5], v: null });
  assert.equal(b.n, 1); assert.equal(b.v[0], 0);
});

test('價格檔檔名: 不含需要網址編碼的字元,和 Python 端同一張對照表', async () => {
  const { priceFileName } = await import('../site/js/engine/data.js');
  const cases = { SPY: 'SPY', 'BRK-B': 'BRK-B', '2330.TW': '2330.TW', '^VIX': '_5eVIX', 'CL=F': 'CL_3dF', A_B: 'A_5fB', 'X^Y': 'X_5eY', X_5eY: 'X_5f5eY' };
  for (const [id, name] of Object.entries(cases)) assert.equal(priceFileName(id), name);
  assert.equal(new Set(Object.keys(cases).map(priceFileName)).size, Object.keys(cases).length);
  for (const name of Object.values(cases)) assert.equal(encodeURIComponent(name), name, '檔名本身不需要編碼');
});
