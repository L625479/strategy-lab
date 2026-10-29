// 端對端測試: 輸入代號自動下載資料(本機伺服器的 /api + 標的選擇器),在真實的 Chromium 裡操作。
// Yahoo 是假的(tests-js/e2e/fixture.mjs 的 mockYahoo,不連網、合成資料)。
//   node --test tests-js/e2e/download.e2e.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

import { startServer } from '../../tools/serve.mjs';
import { buildSite, mockYahoo } from './fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

let browser, withApi, plain, yahoo;
before(async () => {
  const site = buildSite();
  yahoo = mockYahoo();
  withApi = await startServer(site, 0, { api: { fetchImpl: yahoo.fetchImpl, pauseMs: 0, sleep: async () => {} } });
  plain = await startServer(site, 0);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); withApi?.close(); plain?.close(); });

async function open(server, { viewport = { width: 1440, height: 1000 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('.kpis');
  return { page, context, problems };
}

const search = (page) => page.locator('input[aria-label="搜尋標的"]');
const ready = (page) => page.waitForSelector('input[placeholder^="輸入代號或公司名稱"]');
const chipSyms = (page) => page.$$eval('.chips .chip strong', (els) => els.map((e) => e.textContent));

test('純靜態託管(沒有 /api): 找不到的標的會說明要用 serve.mjs 啟動,不會假裝能下載', async () => {
  const { page, context, problems } = await open(plain);
  await search(page).fill('AAPL');
  await page.waitForSelector('text=目前沒有啟用自動下載');
  assert.equal(await page.locator('[data-testid=net-results]').count(), 0);
  assert.match(await page.textContent('#panel'), /node tools\/serve\.mjs site 8080/);
  await search(page).press('Enter');
  assert.deepEqual(await chipSyms(page), ['SPY'], 'Enter 不會下載');
  await search(page).fill('SPY');                                        // 清單裡有的標的: 不顯示提示
  assert.equal(await page.locator('text=目前沒有啟用自動下載').count(), 0);
  assert.deepEqual(problems, []);
  await context.close();
});

test('輸入代號 → 搜尋結果 → 下載 → 自動選取 → 直接回測', async () => {
  const { page, context, problems } = await open(withApi);
  await ready(page);
  assert.match(await page.textContent('#panel'), /輸入代號按 Enter.*Yahoo Finance/);
  await search(page).fill('apple');
  await page.waitForSelector('[data-testid=net-results] button:has-text("AAPL.MX")');
  const rows = await page.$$eval('[data-testid=net-results] button', (bs) => bs.map((b) => b.textContent));
  assert.ok(rows.some((r) => /AAPL.*Apple Inc\..*NASDAQ.*股票/.test(r)), rows.join('|'));
  assert.ok(rows.some((r) => /AAPL\.MX.*APPLE INC\./.test(r)));
  await page.click('[data-testid=net-results] button[aria-label="下載 AAPL"]');
  await page.waitForSelector('text=已下載 AAPL(AAPL Inc.)');
  const msg = await page.textContent('#panel p[role=status]');
  assert.match(msg, /800 根日線 .* ~ .*調整後價格,來源 Yahoo Finance/);
  assert.deepEqual(await chipSyms(page), ['AAPL'], '單一標的模式: 下載後自動換成它');
  assert.match(await page.textContent('.picker'), /已下載\(Yahoo\)/);
  assert.equal(await search(page).inputValue(), '', '搜尋框清空');
  assert.equal(await page.locator('[data-testid=net-results]').count(), 0);

  await page.click('#run');
  await page.waitForSelector('.kpis');
  await page.waitForFunction(() => /AAPL/.test(document.querySelector('#results').textContent));
  assert.match(await page.textContent('#results'), /AAPL/);
  assert.deepEqual(problems, []);
  await context.close();
});

test('輸入代號按 Enter 直接下載(不必等搜尋結果),投資組合模式會加進組合', async () => {
  const { page, context } = await open(withApi);
  await ready(page);
  await page.click('button:has-text("投資組合")');
  await search(page).fill('msft');
  await search(page).press('Enter');
  await page.waitForSelector('text=已下載 MSFT');
  assert.deepEqual(await chipSyms(page), ['SPY', 'MSFT']);
  await search(page).fill('^gspc');
  await search(page).press('Enter');
  await page.waitForSelector('text=已下載 ^GSPC');
  assert.deepEqual(await chipSyms(page), ['SPY', 'MSFT', '^GSPC'], '代號含 ^ 也保留原樣');
  await context.close();
});

test('錯誤: 找不到的代號、被限流、資料不可靠(收盤價疑似過期)都顯示原因,也不會加進清單', async () => {
  const { page, context } = await open(withApi);
  await ready(page);
  for (const [sym, re] of [['ZZZZ', /下載失敗: Yahoo 找不到代號「ZZZZ」.*\.TW/], ['LIMIT', /下載失敗: .*限流/], ['STALE', /下載失敗: 「STALE」不收錄.*疑似過期/]]) {
    await search(page).fill(sym);
    await search(page).press('Enter');
    await page.waitForFunction(([r]) => new RegExp(r).test(document.querySelector('#panel p[role=status]')?.textContent || ''), [re.source]);
    assert.match(await page.textContent('#panel p[role=status]'), re);
  }
  assert.deepEqual(await chipSyms(page), ['SPY']);
  assert.equal(await page.locator('.picker .sym:text-is("ZZZZ")').count(), 0);
  // 格式不對的輸入: Enter 不會送出
  const before = yahoo.calls.length;
  await search(page).fill('bad symbol!');
  await search(page).press('Enter');
  assert.equal(yahoo.calls.length, before, '格式不對的代號不會送給伺服器');
  await context.close();
});

test('下載的資料存在瀏覽器裡: 重新整理後還在、可以更新(略過快取)、可以刪除', async () => {
  const { page, context } = await open(withApi);
  await ready(page);
  await search(page).fill('TSLA'); await search(page).press('Enter');
  await page.waitForSelector('text=已下載 TSLA');
  await page.reload();
  await page.waitForSelector('.kpis'); await ready(page);
  await page.waitForSelector('.picker .sym:text-is("TSLA")');
  assert.match(await page.textContent('.picker'), /已下載\(Yahoo\)/);

  const before = yahoo.calls.length;
  await page.click('button[aria-label="重新下載 TSLA"]');
  await page.waitForSelector('text=已更新 TSLA');
  assert.equal(yahoo.calls.length, before + 1, '重新下載會真的再問一次 Yahoo(不是用快取)');
  assert.equal(new Set(await page.$$eval('.picker .sym', (els) => els.map((e) => e.textContent))).has('TSLA'), true);

  await page.click('button[aria-label="刪除下載的資料 TSLA"]');
  await page.waitForFunction(() => ![...document.querySelectorAll('.picker .sym')].some((e) => e.textContent === 'TSLA'));
  await page.reload(); await page.waitForSelector('.kpis');
  assert.equal(await page.locator('.picker .sym:text-is("TSLA")').count(), 0, '刪除後重新整理也不會回來');
  await context.close();
});

test('目標權重與當沖掃描分頁也看得到下載的標的', async () => {
  const { page, context } = await open(withApi);
  await ready(page);
  await search(page).fill('NVDA'); await search(page).press('Enter');
  await page.waitForSelector('text=已下載 NVDA');
  await page.click('#tab-w');
  await page.waitForSelector('#panel-w .card');
  assert.ok((await page.$$eval('#panel-w select option', (os) => os.map((o) => o.value))).includes('NVDA'), '目標權重的序列選單');
  await page.click('#tab-dt');
  await page.waitForSelector('#panel-dt .card');
  await page.click('#panel-dt >> text=全選');
  await page.click('text=載入選取的標的');
  await page.waitForSelector('[data-testid=dt-info]');
  assert.match(await page.textContent('[data-testid=dt-info]'), /\d+ 檔/);
  await context.close();
});

test('手機寬度: 搜尋結果與下載訊息不會讓頁面橫向溢出', async () => {
  const { page, context } = await open(withApi, { viewport: { width: 390, height: 800 } });
  await ready(page);
  await search(page).fill('apple');
  await page.waitForSelector('[data-testid=net-results] button:has-text("AAPL.MX")');
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await context.close();
});
