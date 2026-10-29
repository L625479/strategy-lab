// 網站端呼叫 /api 的小模組(site/js/engine/remote.js)。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apiAvailable, downloadSeries, searchSymbols } from '../site/js/engine/remote.js';

const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError('not json'); return body; } });

test('apiAvailable: 首頁沒有標記就不發請求;有標記且 health 正常才算有', async () => {
  let n = 0;
  const spy = (r) => async (...a) => { n++; return r(...a); };
  assert.equal(await apiAvailable({ marked: false, fetchImpl: spy(reply(200, { ok: true, service: 'strategy-lab' })) }), false);
  assert.equal(n, 0, '純靜態託管不會多送一個請求');
  assert.equal(await apiAvailable({ fetchImpl: reply(200, { ok: true, service: 'strategy-lab', version: 1 }) }), true);
  assert.equal(await apiAvailable({ fetchImpl: reply(200, { ok: true, service: 'something-else' }) }), false);
  assert.equal(await apiAvailable({ fetchImpl: reply(404, undefined) }), false, '靜態伺服器的 404 頁不是 JSON');
  assert.equal(await apiAvailable({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }), false);
});

test('請求帶 X-Strategy-Lab 標頭、用相對網址、代號與搜尋文字有編碼', async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push([url, opts]); return { ok: true, status: 200, json: async () => ({ d: ['2024-01-02', '2024-01-03'], o: [1, 2], h: [2, 3], l: [1, 1], c: [2, 3], v: [1, 1], symbol: '^GSPC', name: 'S&P 500', warn: '', updated: '2026-10-29' }) }; };
  await searchSymbols('台積電 & co', { fetchImpl });
  await downloadSeries('^GSPC', { fetchImpl });
  await downloadSeries('CL=F', { fetchImpl, fresh: true });
  assert.deepEqual(seen.map(([u]) => u), ['api/search?q=%E5%8F%B0%E7%A9%8D%E9%9B%BB%20%26%20co', 'api/prices?symbol=%5EGSPC', 'api/prices?symbol=CL%3DF&fresh=1']);
  assert.ok(seen.every(([, o]) => o.headers['X-Strategy-Lab'] === '1' && o.cache === 'no-store'));
});

test('downloadSeries: 轉成 bars 並帶回名稱與警告;伺服器的錯誤訊息原樣丟出,不是 JSON 的錯誤用狀態碼', async () => {
  const body = { d: ['2024-01-02', '2024-01-03'], o: [1, 2], h: [2, 3], l: [1, 1], c: [2, 3], v: [5, 6], symbol: 'AAPL', name: 'Apple Inc.', warn: '只有 2 根', updated: '2026-10-29', currency: 'USD', exchange: 'NASDAQ', stats: { n: 2 } };
  const { bars, info } = await downloadSeries('AAPL', { fetchImpl: reply(200, body) });
  assert.equal(bars.n, 2); assert.ok(bars.c instanceof Float64Array); assert.deepEqual([...bars.c], [2, 3]);
  assert.deepEqual(info, { symbol: 'AAPL', name: 'Apple Inc.', source: undefined, updated: '2026-10-29', currency: 'USD', exchange: 'NASDAQ', warn: '只有 2 根', stats: { n: 2 } });
  await assert.rejects(downloadSeries('ZZZZ', { fetchImpl: reply(404, { error: 'Yahoo 找不到代號「ZZZZ」' }) }), /Yahoo 找不到代號「ZZZZ」/);
  await assert.rejects(downloadSeries('X', { fetchImpl: reply(502, undefined) }), /伺服器回應 HTTP 502/);
  await assert.rejects(downloadSeries('X', { fetchImpl: reply(200, { d: [], o: [] }) }), /價格檔格式不正確/);
});
