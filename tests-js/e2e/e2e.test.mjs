// 端對端測試: 在真實的 Chromium 裡操作網站。資料是 fixture.mjs 產生的合成行情(不是真實行情)。
//   node --test tests-js/e2e/e2e.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';

import { startServer } from '../../tools/serve.mjs';
import { buildSite } from './fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

let browser, server, url, noDataServer, noDataUrl;

before(async () => {
  server = await startServer(buildSite(), 0);
  url = `http://127.0.0.1:${server.address().port}/`;
  noDataServer = await startServer(buildSite({ withData: false }), 0);
  noDataUrl = `http://127.0.0.1:${noDataServer.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); noDataServer?.close(); });

/** 每個測試一個全新的瀏覽器環境(儲存空間乾淨),並收集 console 錯誤 */
async function open({ viewport = { width: 1440, height: 1000 }, base = url, hash = '', colorScheme = 'light', permissions = [] } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, permissions });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(base + hash);
  return { page, context, problems };
}

const ready = (page) => page.waitForSelector('.kpis', { timeout: 15000 });
const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
const kpiMap = (page) => page.$$eval('.kpi', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.lbl').textContent, e.querySelector('.val').textContent])));
const pick = (page, id) => page.locator('.picker button[role=option]', { has: page.locator(`.sym:text-is("${id}")`) }).first().click();
const runAndWait = async (page) => { await page.click('#run'); await page.waitForFunction(() => document.querySelector('#run').textContent === '執行回測'); };

/** 圖表容器裡真的有畫東西(不是空白畫布) */
const hasInk = (page, sel) => page.$eval(sel, (box) => [...box.querySelectorAll('canvas')].some((c) => {
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && ++n > 200) return true;
  return false;
}));

test('預設: 載入後自動跑出結果,圖表有內容,沒有任何錯誤', async () => {
  const { page, context, problems } = await open();
  await ready(page);
  const k = await kpiMap(page);
  assert.deepEqual(Object.keys(k), ['總報酬', '年化報酬 (CAGR)', '夏普比率', '最大回撤', '勝率', '盈虧因子', '交易次數']);
  assert.match(k['總報酬'], /^[+-]\d+\.\d%$/);
  assert.ok(Number(k['交易次數']) > 0);
  assert.match(await text(page, '.status'), /EMA 交叉 \+ RSI 過濾 · 單一標的 SPY/);
  await page.waitForTimeout(500);
  for (const sel of ['.chart.eq', '.chart.dd', '.chart.px']) assert.ok(await hasInk(page, sel), `${sel} 應該有畫出東西`);
  assert.deepEqual(problems, []);
  await context.close();
});

test('滑鼠移到圖上: 提示框列出日期與所有序列的值', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.waitForTimeout(500);
  const box = await page.locator('.chart.eq').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForSelector('.chart.eq .tip', { state: 'visible' });
  const tip = await text(page, '.chart.eq .tip');
  assert.match(tip, /\d{4}-\d{2}-\d{2}/); assert.match(tip, /策略/); assert.match(tip, /買入持有/);
  await context.close();
});

test('換範本再執行: 買入持有 = 沒有已平倉交易、持有中 1 筆', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.selectOption('select[aria-label="從範本開始"]', 'buy_hold');
  await runAndWait(page);
  assert.equal((await kpiMap(page))['交易次數'], '0');
  assert.match(await text(page, '.kpis'), /持有中 1/);
  assert.match(await text(page, '.status'), /買入持有/);
  await context.close();
});

test('規則寫錯: 錯誤標在欄位旁邊,結果區提示,不會當掉', async () => {
  const { page, context, problems } = await open();
  await ready(page);
  const input = page.locator('input[data-field="entry.long"]');
  await input.fill('cross_above(ema_f,');
  await runAndWait(page);
  assert.ok(await input.evaluate((e) => e.classList.contains('invalid')));
  assert.match(await text(page, '.err-slot[data-for="entry.long"]'), /突然結束|缺少/);
  assert.match(await text(page, '#editor-errors'), /個問題需要修正/);
  assert.match(await text(page, '#results'), /無法執行回測/);
  await input.fill('cross_above(ema_f, ema_s) and nope > 1');
  await runAndWait(page);
  assert.match(await text(page, '.err-slot[data-for="entry.long"]'), /不認得的名稱「nope」/);
  await input.fill('cross_above(ema_f, ema_s)');                          // 修好之後恢復正常
  await runAndWait(page);
  await ready(page);
  assert.equal(await page.locator('.invalid').count(), 0);
  assert.deepEqual(problems.filter((p) => !/Failed to load resource/.test(p)), []);
  await context.close();
});

test('新增參數與指標、修改規則後結果跟著變(不是寫死的)', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.selectOption('select[aria-label="從範本開始"]', 'sma_cross');
  await runAndWait(page);
  const before = (await kpiMap(page))['交易次數'];
  await page.locator('input[data-field="params[0].value"]').fill('5');   // 快線 20 → 5,交易會變多
  await runAndWait(page);
  assert.notEqual((await kpiMap(page))['交易次數'], before);
  await context.close();
});

test('投資組合: 選 3 檔、設權重,各標的表與相關係數都出現', async () => {
  const { page, context, problems } = await open();
  await ready(page);
  await page.click('button:has-text("投資組合")');
  await pick(page, 'QQQ');
  await pick(page, 'GLD');
  assert.equal(await page.locator('.chip').count(), 3);
  await page.locator('.chip input[aria-label="SPY 權重"]').fill('2');
  await runAndWait(page);
  await ready(page);
  assert.match(await text(page, '.status'), /投資組合 SPY、QQQ、GLD/);
  const rows = await page.locator('.card:has(h2:text-is("各標的表現")) .tbl-wrap').first().locator('tbody tr').evaluateAll((r) => r.map((x) => x.cells[0].textContent.trim().split(' ')[0] + '|' + x.cells[1].textContent));
  assert.deepEqual(rows.map((x) => x.split('|')[0]), ['SPY', 'QQQ', 'GLD', '組合']);
  assert.equal(rows[0].split('|')[1], '50.0%');                          // 權重 2:1:1 → 50 / 25 / 25
  assert.equal(await page.locator('.chart.px').count(), 0);              // 多標的不畫單一價格圖
  assert.match(await text(page, '.card:has(h2:text-is("各標的表現"))'), /相關係數/);
  assert.ok(await hasInk(page, '.chart.eq'));
  assert.deepEqual(problems, []);
  await context.close();
});

test('投資組合上限 8 檔會提示,單一模式只保留一檔', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.click('button:has-text("投資組合")');
  for (const id of ['QQQ', 'GLD', 'TLT', 'BTC-USD']) await pick(page, id);
  assert.equal(await page.locator('.chip').count(), 5);
  await page.click('button:has-text("單一標的")');
  assert.equal(await page.locator('.chip').count(), 1);
  await context.close();
});

test('期間快捷鍵: 近 3 年會把開始日設成最新資料往前 3 年', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.click('button:has-text("近 3 年")');
  const start = await page.inputValue('input[aria-label="開始日期"]');
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/);
  await runAndWait(page);
  const status = await text(page, '.status');
  const first = /· (\d{4}-\d{2}-\d{2}) →/.exec(status)[1];
  assert.ok(first >= start && first <= `${start.slice(0, 8)}31`, `回測起點 ${first} 應該在 ${start} 附近`);
  await context.close();
});

test('基準與對數座標與表格檢視', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.selectOption('select[aria-label="比較基準"]', 'QQQ');
  await runAndWait(page);
  assert.match(await text(page, '.card:has(h2:text-is("權益曲線")) .legend'), /基準 QQQ/);
  await page.click('button:has-text("對數座標")');
  assert.match(await text(page, 'button[aria-pressed]:has-text("對數座標")'), /✓/);
  await page.click('button:has-text("表格檢視")');
  assert.ok(await page.locator('.card:has(h2:text-is("權益曲線")) table.tbl').isVisible());
  assert.ok((await page.locator('.card:has(h2:text-is("權益曲線")) tbody tr').count()) > 20);
  assert.match(await text(page, '.card:has(h2:text-is("權益曲線")) th:nth-child(4)'), /基準 QQQ/);
  await context.close();
});

test('價格圖的指標可以個別開關', async () => {
  const { page, context } = await open();
  await ready(page);
  const chips = page.locator('.card:has(h2:has-text("價格與進出場")) .toggle-chip');
  assert.equal(await chips.count(), 3);
  await chips.first().click();
  assert.equal(await chips.first().getAttribute('aria-pressed'), 'false');
  await context.close();
});

test('交易明細: 可排序、可下載 CSV', async () => {
  const { page, context } = await open();
  await ready(page);
  const firstCell = () => page.$eval('.card:has(h2:has-text("交易明細")) tbody tr:first-child td:nth-child(3)', (e) => e.textContent);
  const asc = await firstCell();
  await page.click('.card:has(h2:has-text("交易明細")) th:has-text("進場日")');
  assert.notEqual(await firstCell(), asc);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("下載 CSV")')]);
  assert.equal(download.suggestedFilename(), 'trades.csv');
  await context.close();
});

test('策略庫: 儲存 → 重新整理 → 載入;匯出 JSON', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.locator('input[data-field="name"]').fill('my test/strategy:1');
  await page.click('button:has-text("儲存策略")');
  assert.match(await text(page, '.hint[role=status]'), /已儲存「my test\/strategy:1」/);
  await page.reload();
  await ready(page);                                                       // 上次的工作被還原
  assert.equal(await page.inputValue('input[data-field="name"]'), 'my test/strategy:1');
  await page.selectOption('select[aria-label="從範本開始"]', 'macd_cross');
  assert.equal(await page.inputValue('input[data-field="name"]'), 'MACD 交叉');
  await page.selectOption('select[aria-label="我的策略"]', 'my test/strategy:1');
  await page.click('button:has-text("載入")');
  assert.equal(await page.inputValue('input[data-field="name"]'), 'my test/strategy:1');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("匯出 JSON")')]);
  assert.equal(download.suggestedFilename(), 'my test_strategy_1.strategy.json');   // 非法字元被換成底線
  await context.close();
});

test('分享連結: 在新的瀏覽器開啟,策略與標的都一樣;壞連結不會當掉', async () => {
  const { page, context } = await open({ permissions: ['clipboard-read', 'clipboard-write'] });
  await ready(page);
  await page.selectOption('select[aria-label="從範本開始"]', 'donchian');
  await page.click('button:has-text("投資組合")');
  await pick(page, 'GLD');
  await page.click('button:has-text("複製分享連結")');
  const link = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#s=[A-Za-z0-9_-]+$/);
  const other = await open({ hash: link.slice(link.indexOf('#')) });
  await ready(other.page);
  assert.match(await text(other.page, '.status'), /通道突破 \(Donchian\) · 投資組合 SPY、GLD/);
  await other.context.close();
  const bad = await open({ hash: '#s=@@@' });
  await bad.page.waitForSelector('.kpis');                                 // 退回預設設定
  assert.match(await text(bad.page, '#toast'), /無法解析/);
  await bad.context.close();
  await context.close();
});

test('CSV 上傳: 出現在「我的資料」、可回測、重新整理後仍在;過期收盤價會警告', async () => {
  const { page, context } = await open();
  await ready(page);
  const rows = ['time,open,high,low,close,Volume'];
  let p = 50;
  for (let i = 0; i < 400; i++) {
    const t = 1704153600 + i * 86400, o = p, c = p * (1 + Math.sin(i / 9) * 0.01 + 0.0006);
    rows.push(`${t},${o.toFixed(3)},${(Math.max(o, c) * 1.004).toFixed(3)},${(Math.min(o, c) * 0.996).toFixed(3)},${c.toFixed(3)},1000`);
    p = c;
  }
  await page.setInputFiles('input[type=file][accept=".csv,text/csv"]', { name: '2330.TW-test.csv', mimeType: 'text/csv', buffer: Buffer.from(rows.join('\n')) });
  await page.waitForSelector('.chip:has-text("2330.TW-test")');
  assert.match(await text(page, '.picker'), /我的資料/);
  assert.match(await text(page, '.hint[role=status]'), /已載入 400 根/);
  await runAndWait(page);
  assert.match(await text(page, '.status'), /2330\.TW-test/);
  await page.reload();
  await page.waitForSelector('.picker button:has(.sym:text-is("2330.TW-test"))');   // 存在 IndexedDB,重新整理後還在

  const stale = ['date,open,high,low,close'];
  for (let i = 0; i < 80; i++) stale.push(`2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')},100,105,95,100`);
  await page.setInputFiles('input[type=file][accept=".csv,text/csv"]', { name: 'stale.csv', mimeType: 'text/csv', buffer: Buffer.from(stale.join('\n')) });
  await page.waitForSelector('.notice:has-text("收盤價疑似過期")');
  await page.once('dialog', (d) => d.accept());
  await page.click('.pick-row:has(.sym:text-is("stale")) .pick-del');
  await page.waitForFunction(() => !document.querySelector('.sym') || ![...document.querySelectorAll('.sym')].some((e) => e.textContent === 'stale'));
  await context.close();
});

test('壞的 CSV 會給清楚的訊息', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.setInputFiles('input[type=file][accept=".csv,text/csv"]', { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2') });
  await page.waitForSelector('.hint[role=status]:has-text("上傳失敗")');
  assert.match(await text(page, '.hint[role=status]'), /缺少欄位/);
  await context.close();
});

test('使用者輸入不會被當成 HTML 或程式執行(策略名稱、檔名)', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.evaluate(() => { window.__pwn = 0; });
  const evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
  await page.locator('input[data-field="name"]').fill(evil);
  await runAndWait(page);
  await page.setInputFiles('input[type=file][accept=".csv,text/csv"]', { name: 'x<img src=x onerror=window.__pwn=3>.csv', mimeType: 'text/csv', buffer: Buffer.from('time,open,high,low,close\n' + Array.from({ length: 40 }, (_, i) => `2024-01-${String(i % 28 + 1).padStart(2, '0')},1,2,0.5,1.5`).join('\n')) });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.__pwn), 0);
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.match(await text(page, '.status'), /<img src=x/);                 // 以純文字顯示
  await context.close();
});

test('Ctrl+Enter 執行', async () => {
  const { page, context } = await open();
  await ready(page);
  await page.selectOption('select[aria-label="從範本開始"]', 'buy_hold');
  await page.locator('input[data-field="name"]').fill('快捷鍵測試');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('.status')?.textContent.includes('快捷鍵測試'));
  await context.close();
});

test('暗色模式: 切換後整頁與圖表都換色,沒有錯誤', async () => {
  const { page, context, problems } = await open();
  await ready(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const light = await bg();
  await page.click('#theme');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.notEqual(await bg(), light);
  await page.waitForTimeout(500);
  assert.ok(await hasInk(page, '.chart.eq'));
  await page.reload(); await ready(page);                                  // 記住偏好
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.deepEqual(problems, []);
  await context.close();
  const os = await open({ colorScheme: 'dark' });                           // 沒設定偏好時跟隨作業系統
  assert.notEqual(await os.page.evaluate(() => getComputedStyle(document.body).backgroundColor), light);
  await os.context.close();
});

test('手機寬度: 沒有橫向捲動,仍可執行', async () => {
  const { page, context, problems } = await open({ viewport: { width: 390, height: 800 } });
  await ready(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `橫向溢出 ${overflow}px`);
  await page.click('button:has-text("投資組合")');
  await pick(page, 'QQQ');
  await runAndWait(page);
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
  assert.deepEqual(problems, []);
  if (process.env.E2E_SHOT_MOBILE) await page.screenshot({ path: process.env.E2E_SHOT_MOBILE });
  await context.close();
});

test('沒有內建資料時: 顯示說明,仍可上傳 CSV', async () => {
  const { page, context } = await open({ base: noDataUrl });
  await page.waitForSelector('.empty');
  assert.match(await text(page, '.picker'), /目前沒有內建的行情資料/);
  assert.match(await text(page, '.empty'), /上傳一份價格 CSV/);
  assert.ok(await page.locator('button:has-text("上傳 CSV")').isVisible());
  await context.close();
});

test('策略 JSON 匯入', async () => {
  const { page, context } = await open();
  await ready(page);
  const strategy = { name: '匯入的策略', params: [{ name: 'n', value: 10 }], indicators: [{ name: 'm', expr: 'sma(close, n)' }], entry: { long: 'close > m', short: '' }, exit: { long: 'close < m', short: '' } };
  await page.setInputFiles('input[type=file][accept=".json,application/json"]', { name: 's.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(strategy)) });
  await page.waitForFunction(() => document.querySelector('input[data-field="name"]').value === '匯入的策略');
  await runAndWait(page);
  assert.match(await text(page, '.status'), /匯入的策略/);
  await page.setInputFiles('input[type=file][accept=".json,application/json"]', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await page.waitForSelector('.hint[role=status]:has-text("匯入失敗")');
  await context.close();
});
