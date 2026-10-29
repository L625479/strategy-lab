// 本機伺服器的 /api: 驗證輸入、擋掉不該有的請求、錯誤訊息、快取與節流。Yahoo 用假的(注入 fetchImpl),不連網。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { after, test } from 'node:test';

import { startServer } from '../tools/serve.mjs';

const payloads = JSON.parse(readFileSync(new URL('./fixtures/yahoo_payloads.json', import.meta.url), 'utf8'));
const H = { 'X-Strategy-Lab': '1' };
const servers = [];
after(() => { for (const s of servers) s.close(); });

/** 假的 Yahoo: handler(url) 回傳 { status, body };記錄每次呼叫 */
async function boot(handler, apiOpts = {}) {
  const calls = [];
  let t = Date.parse('2026-10-29T12:00:00Z');
  const clock = { advance: (ms) => { t += ms; } };
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), t: Date.now() });
    const r = await handler(String(url), opts);
    return { status: r.status ?? 200, json: async () => r.body };
  };
  const server = await startServer(new URL('../site', import.meta.url).pathname, 0, { api: { fetchImpl, pauseMs: 0, sleep: async () => {}, now: () => new Date(t), ...apiOpts } });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, headers = H) => { const r = await fetch(base + path, { headers }); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };
  return { base, calls, get, clock, server };
}

const chartFor = (name) => ({ status: 200, body: payloads[name] });

test('health: 帶標頭才回應;沒有標頭、Host 不是本機、不是 GET 都被擋下', async () => {
  const { get, base, server } = await boot(() => chartFor('plain'));
  const ok = await get('/api/health');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true, service: 'strategy-lab', version: 1 });
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await get('/api/health', {})).status, 403, '沒有 X-Strategy-Lab 標頭(別的網站的跨網域請求)');
  assert.equal((await get('/api/health', { 'X-Strategy-Lab': '0' })).status, 403);
  assert.equal((await fetch(`${base}/api/health`, { method: 'POST', headers: H })).status, 405);
  assert.equal((await fetch(`${base}/api/health`, { method: 'OPTIONS', headers: { ...H, Origin: 'https://evil.example' } })).status, 405, '預檢請求不回應,沒有任何 CORS 標頭');
  // 假的 Host(DNS rebinding): fetch 不允許改 Host,改用 http.request
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.address().port, path: '/api/health', headers: { ...H, Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  assert.ok(!(await fetch(`${base}/api/health`, { headers: { ...H, Origin: 'https://evil.example' } })).headers.has('access-control-allow-origin'));
});

test('沒有啟用 /api 的伺服器(純靜態託管): /api/health 是 404、首頁沒有標記;啟用時首頁有標記,網站據此決定要不要去問', async () => {
  const server = await startServer(new URL('../site', import.meta.url).pathname, 0);
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health`, { headers: H })).status, 404);
  const plain = await (await fetch(`${base}/`)).text();
  assert.ok(plain.includes('</head>') && !plain.includes('strategy-lab-api'));
  const { base: apiBase } = await boot(() => chartFor('plain'));
  for (const path of ['/', '/index.html']) {
    const marked = await (await fetch(apiBase + path)).text();
    assert.equal((marked.match(/<meta name="strategy-lab-api" content="1">/g) || []).length, 1, path);
    assert.ok(marked.includes('<title>'), '其餘內容不變');
  }
  assert.ok(!(await (await fetch(`${apiBase}/js/app.js`)).text()).includes('<meta name="strategy-lab-api" content="1">'), '只改首頁');
});

test('prices: 回傳清理後的日線;同一個代號(不分大小寫)在快取期間只問一次 Yahoo', async () => {
  const { get, calls } = await boot(() => chartFor('dividend_adjusted'));
  const a = await get('/api/prices?symbol=aapl');
  assert.equal(a.status, 200);
  assert.equal(a.body.symbol, 'TEST'); assert.equal(a.body.name, 'Test Co'); assert.equal(a.body.adjusted, true);
  assert.match(a.body.source, /Yahoo/);
  assert.ok(a.body.d.length === 300 && ['o', 'h', 'l', 'c', 'v'].every((k) => a.body[k].length === 300));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v8\/finance\/chart\/AAPL\?/, '代號轉大寫後才送出');
  await get('/api/prices?symbol=AAPL');
  assert.equal(calls.length, 1, '快取');
  await get('/api/prices?symbol=MSFT');
  assert.equal(calls.length, 2);
});

test('prices: 快取過期後重新抓;years 只接受 1~40,其餘用預設 26', async () => {
  const { get, calls, clock } = await boot(() => chartFor('plain'), { ttlMs: 1000 });
  await get('/api/prices?symbol=AAPL');
  clock.advance(500); await get('/api/prices?symbol=AAPL');
  assert.equal(calls.length, 1);
  clock.advance(600); await get('/api/prices?symbol=AAPL');
  assert.equal(calls.length, 2, 'TTL 過了');
  const period = (c) => { const u = new URL(c.url); return (Number(u.searchParams.get('period2')) - Number(u.searchParams.get('period1'))) / 86400; };
  await get('/api/prices?symbol=BBB&years=3'); await get('/api/prices?symbol=CCC&years=100'); await get('/api/prices?symbol=DDD&years=abc');
  assert.equal(period(calls[2]), Math.trunc(3 * 366) + 10 + 1);
  assert.equal(period(calls[3]), Math.trunc(26 * 366) + 10 + 1);
  assert.equal(period(calls[4]), Math.trunc(26 * 366) + 10 + 1);
});

test('prices: fresh=1 略過快取重新抓(網站的「更新」按鈕);沒帶就用快取', async () => {
  const { get, calls } = await boot(() => chartFor('plain'));
  await get('/api/prices?symbol=AAPL'); await get('/api/prices?symbol=AAPL');
  assert.equal(calls.length, 1);
  await get('/api/prices?symbol=AAPL&fresh=1');
  assert.equal(calls.length, 2);
  await get('/api/prices?symbol=AAPL');
  assert.equal(calls.length, 2, '重新抓的結果會放進快取');
  await get('/api/prices?symbol=AAPL&fresh=0');
  assert.equal(calls.length, 2);
});

test('prices: 格式不對的代號在送出前就被擋下(不會連到 Yahoo)', async () => {
  const { get, calls } = await boot(() => chartFor('plain'));
  for (const bad of ['', '..%2Fetc', 'A%20B', 'AAPL%3Bls', 'AAPL%0A', '%E4%B8%AD%E6%96%87', 'A'.repeat(21), 'AAPL%2FMSFT', 'AAPL%3Fx%3D1', '%00']) {
    const r = await get(`/api/prices?symbol=${bad}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /代號格式不正確/);
  }
  assert.equal((await get('/api/prices')).status, 400);
  assert.equal(calls.length, 0);
  for (const ok of ['%5EGSPC', 'CL%3DF', 'BTC-USD', '2330.TW']) assert.equal((await get(`/api/prices?symbol=${ok}`)).status, 200, ok);
  assert.equal(new URL(calls[0].url).pathname, '/v8/finance/chart/%5EGSPC');
});

test('prices: 錯誤訊息 — 找不到 / 限流 / 資料不可靠 / 連不上,都說得出原因', async () => {
  const modes = { NOPE: { status: 404, body: payloads.yahoo_error }, LIMIT: { status: 429 }, STALE: chartFor('stale_excluded'), EMPTY: chartFor('empty'), YERR: chartFor('yahoo_error') };
  const { get } = await boot((url) => {
    const sym = decodeURIComponent(new URL(url).pathname.split('/').pop());
    if (sym === 'DOWN') throw new TypeError('fetch failed');
    return modes[sym];
  });
  let r = await get('/api/prices?symbol=NOPE');
  assert.equal(r.status, 404); assert.match(r.body.error, /找不到代號「NOPE」.*\.TW/);
  r = await get('/api/prices?symbol=YERR');
  assert.equal(r.status, 404, 'Yahoo 回 200 但說 Not Found');
  r = await get('/api/prices?symbol=EMPTY');
  assert.equal(r.status, 404);
  r = await get('/api/prices?symbol=LIMIT');
  assert.equal(r.status, 503); assert.match(r.body.error, /限流/);
  r = await get('/api/prices?symbol=STALE');
  assert.equal(r.status, 422); assert.match(r.body.error, /不收錄.*疑似過期.*CSV 上傳/);
  r = await get('/api/prices?symbol=DOWN');
  assert.equal(r.status, 502); assert.match(r.body.error, /fetch failed/);
});

test('節流與合併: 同時多個請求對 Yahoo 一次只送一個;同一個代號同時要兩次只問一次', async () => {
  let running = 0, peak = 0;
  const sleeps = [];
  const { get, calls } = await boot(async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running--; return chartFor('plain'); },
    { pauseMs: 250, sleep: async (ms) => { sleeps.push(ms); } });
  const rs = await Promise.all(['A1', 'A2', 'A3', 'A1', 'A2'].map((s) => get(`/api/prices?symbol=${s}`)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(calls.length, 3, '重複的代號合併');
  assert.equal(peak, 1, '一次一個');
  assert.ok(sleeps.filter((x) => x === 250).length >= 3, '每次之間有間隔');
});

test('search: 回傳整理過的結果;空的或太長的文字被擋下;搜尋結果短暫快取', async () => {
  const { get, calls } = await boot(() => ({ status: 200, body: { quotes: [{ symbol: 'AAPL', quoteType: 'EQUITY', longname: 'Apple Inc.', exchDisp: 'NASDAQ' }, { symbol: 'AAPL', quoteType: 'EQUITY' }] } }));
  const r = await get('/api/search?q=Apple');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ symbol: 'AAPL', name: 'Apple Inc.', type: '股票', exchange: 'NASDAQ' }]);
  await get('/api/search?q=apple');
  assert.equal(calls.length, 1, '不分大小寫的快取');
  assert.equal(new URL(calls[0].url).hostname, 'query2.finance.yahoo.com');
  for (const bad of ['', '%20%20', 'x'.repeat(61), 'a%00b', 'a%0Ab']) assert.equal((await get(`/api/search?q=${bad}`)).status, 400, bad);
  assert.equal(calls.length, 1);
  assert.equal((await get('/api/nope')).status, 404);
});

test('search: Yahoo 出錯時回傳可讀的錯誤(限流是 503,其餘 502)', async () => {
  const { get } = await boot((url) => (new URL(url).searchParams.get('q') === 'limit' ? { status: 429 } : { status: 500 }));
  assert.equal((await get('/api/search?q=limit')).status, 503);
  const r = await get('/api/search?q=other');
  assert.equal(r.status, 502); assert.match(r.body.error, /HTTP 500/);
});

test('只會連到 Yahoo 的固定網址: 不論輸入是什麼,送出的主機都是 query1 / query2.finance.yahoo.com', async () => {
  const { get, calls } = await boot(() => chartFor('plain'));
  await get('/api/prices?symbol=AAPL'); await get('/api/search?q=http%3A%2F%2Fevil.example%2F%3F');
  for (const c of calls) assert.ok(['query1.finance.yahoo.com', 'query2.finance.yahoo.com'].includes(new URL(c.url).hostname), c.url);
});
