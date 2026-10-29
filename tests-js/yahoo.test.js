// 抓價格模組(tools/yahoo.mjs)的測試: 清理邏輯對照 Python 版(tools/fetch_prices.py)的標準答案、下載的重試與錯誤、搜尋的解析。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  FetchError, MIN_BARS_ON_DEMAND, SYMBOL_RE, buildSeries, fetchChart, loadSymbol, parseChart, searchSymbols, sig6, verdict,
} from '../tools/yahoo.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const payloads = fx('yahoo_payloads.json'), golden = fx('yahoo_golden.json');
const NOW = new Date('2026-10-29T12:00:00Z');
const todayLocal = (offset) => new Date(NOW.getTime() + offset * 1000).toISOString().slice(0, 10);

test('清理與品質檢查: 每個案例的序列、統計與判定都與 Python 版相同', () => {
  let ok = 0;
  for (const [name, payload] of Object.entries(payloads)) {
    const want = golden[name];
    let parsed;
    try { parsed = parseChart(payload); } catch (e) {
      assert.ok(want.error, `${name}: JS 丟出了錯誤,Python 沒有`);
      if (name === 'empty') assert.equal(e.message, want.error);
      assert.ok(e instanceof FetchError);
      continue;
    }
    assert.ok(!want.error, `${name}: Python 丟出了錯誤(${want.error}),JS 沒有`);
    const today = todayLocal(parsed.offset);
    assert.equal(today, want.today_local, `${name} 今天(當地)`);
    const { series, stats } = buildSeries(parsed, today);
    assert.deepEqual(series, want.series, `${name} 序列`);
    for (const k of Object.keys(want.stats)) {
      if (k === 'stale_share') assert.ok(Math.abs(stats[k] - want.stats[k]) < 1e-15, `${name} ${k}`);
      else assert.equal(stats[k], want.stats[k], `${name} ${k}`);
    }
    const v = verdict(series, stats, today);
    assert.deepEqual([v.ok, v.warn, v.reason], [want.ok, want.warn, want.reason], `${name} 判定`);
    ok++;
  }
  assert.ok(ok >= 20);
});

test('使用者輸入的標的(minBars = 30): 剛好 30 根收錄並警告,29 根拒絕', () => {
  const run = (name) => {
    const parsed = parseChart(payloads[name]);
    const today = todayLocal(parsed.offset);
    const { series, stats } = buildSeries(parsed, today);
    return verdict(series, stats, today, { minBars: MIN_BARS_ON_DEMAND });
  };
  const ok = run('bars_30'), no = run('bars_29');
  assert.equal(ok.ok, true); assert.match(ok.warn, /只有 30 根 K 棒/);
  assert.equal(no.ok, false); assert.match(no.reason, /只有 29 根.*至少需要 30 根/);
  assert.doesNotMatch(run('bars_250').warn, /K 棒/, '250 根以上不再警告根數');
});

test('6 位有效數字: 一般數字與 toPrecision 相同,剛好在中間時進位到偶數(和 Python 的 .6g 相同)', () => {
  assert.equal(sig6(123.456789), 123.457);
  assert.equal(sig6(0.000123456789), 0.000123457);
  assert.equal(sig6(98765.4321), 98765.4);
  assert.equal(sig6(100000.5), 100000);          // 正中間 → 偶數
  assert.equal(sig6(100001.5), 100002);
  assert.equal(sig6(100002.5), 100002);
  assert.equal(sig6(123456.5), 123456);
  assert.equal(sig6(99999.95), 99999.9);         // 二進位表示比 99999.95 略小,不是平手
  assert.equal(sig6(0), 0);
  assert.ok(Number.isNaN(sig6(NaN)));
  assert.equal(sig6(-100000.5), -100000);
});

test('代號格式: 只接受 Yahoo 代號會用到的字元', () => {
  for (const ok of ['AAPL', '2330.TW', '^GSPC', 'BTC-USD', 'CL=F', 'BRK-B', '0700.HK', 'EURUSD=X']) assert.ok(SYMBOL_RE.test(ok), ok);
  for (const bad of ['', ' AAPL', 'AAPL ', 'A/B', '../etc', 'AAPL;ls', 'A'.repeat(21), 'AA%2FPL', 'AAPL?x=1', 'a b', '中文', 'AAPL\n']) assert.ok(!SYMBOL_RE.test(bad), JSON.stringify(bad));
});

// ---- 下載 ----------------------------------------------------------------------

const resp = (status, body) => ({ status, json: async () => body });

test('下載: 429 與 5xx 會退避重試,成功就回傳;網址帶了正確的代號與參數', async () => {
  const calls = [], sleeps = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return calls.length < 3 ? resp(calls.length === 1 ? 429 : 503) : resp(200, payloads.plain);
  };
  const out = await fetchChart('^GSPC', 26, NOW, { fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(out, payloads.plain);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [1000, 2000], '指數退避 1 秒、2 秒');
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, '/v8/finance/chart/%5EGSPC', '代號要編碼');
  assert.equal(u.searchParams.get('interval'), '1d');
  assert.equal(u.searchParams.get('includeAdjustedClose'), 'true');
  assert.equal(u.searchParams.get('events'), 'div,splits');
  const p1 = Number(u.searchParams.get('period1')), p2 = Number(u.searchParams.get('period2'));
  assert.equal(p2, Math.floor(NOW / 1000) + 86400);
  assert.equal(p1, Math.floor(NOW / 1000) - (Math.trunc(26 * 366) + 10) * 86400);
  assert.match(calls[0].opts.headers['User-Agent'], /strategy-lab/);
});

test('下載: 404 等其他狀態碼不重試,直接丟出並帶 status;重試用完也丟出', async () => {
  let n = 0;
  await assert.rejects(fetchChart('ZZZZ', 26, NOW, { fetchImpl: async () => { n++; return resp(404); }, sleep: async () => {} }), (e) => e instanceof FetchError && e.status === 404);
  assert.equal(n, 1);
  n = 0;
  await assert.rejects(fetchChart('AAPL', 26, NOW, { fetchImpl: async () => { n++; return resp(429); }, sleep: async () => {} }), (e) => e.status === 429 && /重試 3 次仍失敗/.test(e.message));
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(fetchChart('AAPL', 26, NOW, { fetchImpl: async () => { n++; throw new TypeError('fetch failed'); }, sleep: async () => {} }), /fetch failed/);
  assert.equal(n, 3, '連線錯誤也重試');
});

test('loadSymbol: 回傳網站用的 JSON(名稱、來源、警告、序列);少於 250 根但至少 30 根會收錄並警告', async () => {
  const ok = await loadSymbol('TEST', { now: NOW, fetchImpl: async () => resp(200, payloads.dividend_adjusted), sleep: async () => {} });
  assert.equal(ok.symbol, 'TEST'); assert.equal(ok.name, 'Test Co'); assert.equal(ok.adjusted, true);
  assert.match(ok.source, /Yahoo/); assert.equal(ok.updated, '2026-10-29');
  assert.deepEqual([ok.d, ok.o, ok.h, ok.l, ok.c, ok.v], [golden.dividend_adjusted.series.d, ...['o', 'h', 'l', 'c', 'v'].map((k) => golden.dividend_adjusted.series[k])]);
  assert.equal(ok.stats.n, 300);

  const few = await loadSymbol('TEST', { now: NOW, fetchImpl: async () => resp(200, payloads.too_few_bars), sleep: async () => {} });
  assert.equal(few.stats.n, 120);
  assert.match(few.warn, /只有 120 根 K 棒/);
  await assert.rejects(loadSymbol('TEST', { now: NOW, minBars: 250, fetchImpl: async () => resp(200, payloads.too_few_bars), sleep: async () => {} }), /至少需要 250 根/);
  assert.equal(MIN_BARS_ON_DEMAND, 30);
});

test('loadSymbol: 收盤價疑似過期的標的被拒絕並說明原因(不是默默收錄)', async () => {
  await assert.rejects(loadSymbol('TEST', { now: NOW, fetchImpl: async () => resp(200, payloads.stale_excluded), sleep: async () => {} }),
    (e) => e instanceof FetchError && e.status === 422 && /疑似過期/.test(e.message));
  const warnOnly = await loadSymbol('TEST', { now: NOW, fetchImpl: async () => resp(200, payloads.stale_warn_only), sleep: async () => {} });
  assert.match(warnOnly.warn, /可能過期/);
});

test('loadSymbol: Yahoo 回報錯誤或沒有 K 棒時丟出 FetchError', async () => {
  await assert.rejects(loadSymbol('TEST', { now: NOW, fetchImpl: async () => resp(200, payloads.yahoo_error), sleep: async () => {} }), FetchError);
  await assert.rejects(loadSymbol('TEST', { now: NOW, fetchImpl: async () => resp(200, payloads.empty), sleep: async () => {} }), /沒有回傳任何 K 棒/);
});

// ---- 搜尋 ----------------------------------------------------------------------

test('搜尋: 解析 Yahoo 的回應、只留認得的種類、去重、限制筆數與長度,格式不對時回傳空陣列', async () => {
  const quotes = [
    { symbol: 'AAPL', quoteType: 'EQUITY', longname: 'Apple Inc.', shortname: 'Apple', exchDisp: 'NASDAQ' },
    { symbol: 'AAPL', quoteType: 'EQUITY', longname: 'dup' },
    { symbol: 'AAPL.MX', quoteType: 'EQUITY', shortname: 'APPLE INC.', exchange: 'MEX' },
    { symbol: 'SPY', quoteType: 'ETF', shortname: 'SPDR S&P 500' },
    { symbol: 'BTC-USD', quoteType: 'CRYPTOCURRENCY', shortname: 'Bitcoin USD' },
    { symbol: '^GSPC', quoteType: 'INDEX', shortname: 'S&P 500' },
    { symbol: 'WEIRD', quoteType: 'OPTION', shortname: 'x' },
    { symbol: 'bad symbol', quoteType: 'EQUITY' },
    { quoteType: 'EQUITY' },
    ...Array.from({ length: 20 }, (_, i) => ({ symbol: `T${i}`, quoteType: 'EQUITY', longname: 'x'.repeat(200) })),
  ];
  const seen = [];
  const out = await searchSymbols('apple', { fetchImpl: async (url) => { seen.push(url); return resp(200, { quotes }); } });
  assert.deepEqual(out.map((x) => x.symbol), ['AAPL', 'AAPL.MX', 'SPY', 'BTC-USD', '^GSPC', 'T0', 'T1', 'T2'], '不認得的種類(OPTION)、壞代號、沒有代號的都被濾掉');
  assert.deepEqual(out[0], { symbol: 'AAPL', name: 'Apple Inc.', type: '股票', exchange: 'NASDAQ' });
  assert.equal(out[1].name, 'APPLE INC.'); assert.equal(out[1].exchange, 'MEX');
  assert.equal(out.length, 8);
  assert.ok(out.every((x) => x.name.length <= 80));
  assert.equal(new URL(seen[0]).searchParams.get('q'), 'apple');
  assert.deepEqual(await searchSymbols('x', { fetchImpl: async () => resp(200, { quotes: 'nope' }) }), []);
  assert.deepEqual(await searchSymbols('x', { fetchImpl: async () => resp(200, null) }), []);
  await assert.rejects(searchSymbols('x', { fetchImpl: async () => resp(429) }), (e) => e.status === 429);
  await assert.rejects(searchSymbols('x', { fetchImpl: async () => resp(500) }), /HTTP 500/);
});
