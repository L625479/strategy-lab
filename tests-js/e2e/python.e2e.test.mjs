// 端對端測試: 在網站上選用「Python 策略」(真的 Python 子行程 + 真的 Chromium)。Yahoo 是假的(合成資料)。
//   node --test tests-js/e2e/python.e2e.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { startServer } from '../../tools/serve.mjs';
import { buildSite, mockYahoo } from './fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const DIR = fileURLToPath(new URL('../fixtures/py_strategies', import.meta.url));
const hasPython = (() => { for (const py of ['python3', 'python']) { try { execFileSync(py, ['-c', 'import pandas, numpy'], { stdio: 'ignore' }); return true; } catch { /* 下一個 */ } } return false; })();
const opts = { skip: hasPython ? false : '需要 Python 3 與 pandas / numpy' };

let browser, withPy, noPython, plain;
before(async () => {
  const site = buildSite();
  const yahoo = mockYahoo();
  const api = (py) => ({ fetchImpl: yahoo.fetchImpl, pauseMs: 0, sleep: async () => {}, py });
  withPy = await startServer(site, 0, { api: api({ dir: DIR }) });
  noPython = await startServer(site, 0, { api: api({ dir: DIR, python: '/nonexistent/python-xyz' }) });
  plain = await startServer(site, 0);
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); withPy?.close(); noPython?.close(); plain?.close(); });

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

const toPython = async (page) => { await page.click('button:has-text("Python 策略")'); };
const pickStrategy = async (page, id) => { await page.waitForSelector('select[aria-label="Python 策略"]:not([disabled])'); await page.selectOption('select[aria-label="Python 策略"]', id); };
const search = (page) => page.locator('input[aria-label="搜尋標的"]');
const download = async (page, sym) => { await search(page).fill(sym); await search(page).press('Enter'); await page.waitForSelector(`text=已下載 ${sym}`); };
const kpis = (page) => page.textContent('#results .kpis');
const waitResults = (page, re) => page.waitForFunction((s) => new RegExp(s).test(document.querySelector('#results')?.textContent || ''), re.source, { timeout: 60000 });

test('沒有 /api(純靜態託管)或沒有 Python: 說明原因,不會假裝能用', async () => {
  const a = await open(plain);
  await toPython(a.page);
  await a.page.waitForSelector('[data-testid=py-unavailable]');
  assert.match(await a.page.textContent('[data-testid=py-unavailable]'), /node tools\/serve\.mjs site 8080/);
  assert.equal(await a.page.isDisabled('select[aria-label="Python 策略"]'), true);
  await a.page.click('#run');
  assert.match(await a.page.textContent('#editor-errors'), /請選擇一個 Python 策略/);
  assert.match(await a.page.textContent('#results'), /策略有 1 個問題/);
  await a.context.close();
  const b = await open(noPython, {});
  await toPython(b.page);
  await b.page.waitForSelector('[data-testid=py-unavailable]');
  assert.match(await b.page.textContent('[data-testid=py-unavailable]'), /找不到 Python/);
  await b.context.close();
});

test('選 Python 策略 → 輸入代號 → 自動抓資料並回測;結果與同一個邏輯寫成規則策略完全相同', opts, async () => {
  const { page, context, problems } = await open(withPy);
  await toPython(page);
  await page.waitForSelector('[data-testid=py-status]');
  assert.match(await page.textContent('[data-testid=py-status]'), /Python 3\.\d+.*pandas.*py_strategies/);
  const options = await page.$$eval('select[aria-label="Python 策略"] option', (os) => os.map((o) => o.value));
  assert.deepEqual(options, ['', 'boom', 'cheat_lookahead', 'noisy', 'sleepy', 'slow', 'sma_cross', 'trend_filter', 'trend_long_short'], '_hidden 不列');
  await pickStrategy(page, 'sma_cross');
  assert.equal(await page.inputValue('input[aria-label="python.params.fast"]'), '10', '預設參數來自策略檔的 PARAMS');
  await page.fill('input[aria-label="python.params.fast"]', '8');
  await page.fill('input[aria-label="python.params.slow"]', '25');
  await download(page, 'MSFT');                                          // 下載完成就用目前的策略回測
  await waitResults(page, /MSFT/);
  const pyKpis = await kpis(page);
  assert.match(await page.textContent('#results'), /範例: SMA 交叉/, '結果頁標示 Python 策略的名稱(不是範本的名稱)');
  const tradeCount = Number((/(\d+) 勝\s*(\d+) 敗/.exec(pyKpis) || [])[1]) + Number((/(\d+) 勝\s*(\d+) 敗/.exec(pyKpis) || [])[2]);
  assert.ok(tradeCount >= 5, `要有足夠的交易才有比對意義(${tradeCount})`);

  // 同樣的邏輯用規則語法寫: 績效指標必須一模一樣
  await page.click('button:has-text("規則策略")');
  await page.fill('input[aria-label="entry.long"]', 'cross_above(sma(close, 8), sma(close, 25))');
  await page.fill('input[aria-label="exit.long"]', 'cross_below(sma(close, 8), sma(close, 25))');
  await page.click('#run');
  await page.waitForFunction((k) => document.querySelector('#results .kpis')?.textContent !== k || true, pyKpis);
  await page.waitForTimeout(800);
  assert.equal(await kpis(page), pyKpis, 'Python 與規則語法: 同一份資料、同一個邏輯 → 績效完全相同');

  // 改參數: 結果跟著變;重新整理後選擇與參數還在
  await toPython(page);
  await page.fill('input[aria-label="python.params.fast"]', '4');
  await page.click('#run');
  await page.waitForFunction((k) => document.querySelector('#results .kpis')?.textContent !== k, pyKpis, { timeout: 60000 });
  await page.reload();
  await page.waitForSelector('.kpis');
  assert.match(await page.textContent('#panel'), /Python 策略/);
  await page.waitForSelector('select[aria-label="Python 策略"]:not([disabled])');
  assert.equal(await page.inputValue('select[aria-label="Python 策略"]'), 'sma_cross');
  assert.equal(await page.inputValue('input[aria-label="python.params.fast"]'), '4');
  assert.deepEqual(problems, []);
  await context.close();
});

test('偷看未來的策略: 照樣回測,但結果頁有明確的警告;出錯的策略顯示錯誤說明', opts, async () => {
  const { page, context } = await open(withPy);
  await toPython(page);
  await pickStrategy(page, 'cheat_lookahead');
  await page.click('#run');
  await waitResults(page, /疑似用到了未來的資料/);
  assert.match(await page.textContent('#results'), /截短到前 \d+ 根.*shift\(-1\)/);
  // 關掉檢查就沒有警告
  await page.uncheck('input[aria-label="檢查偷看未來"]');
  await page.click('#run');
  await page.waitForFunction(() => !/疑似用到了未來的資料/.test(document.querySelector('#results')?.textContent || ''), null, { timeout: 60000 });
  await pickStrategy(page, 'boom');
  await page.click('#run');
  await waitResults(page, /Python 策略「boom」: 策略執行時出錯: KeyError/);
  assert.match(await page.textContent('#results'), /無法執行回測/);
  await context.close();
});

test('策略的 print 輸出顯示在結果頁;「允許做空」讓 -1 的部位真的放空', opts, async () => {
  const { page, context } = await open(withPy);
  await toPython(page);
  await pickStrategy(page, 'noisy');
  await page.click('#run');
  await waitResults(page, /Python 策略的輸出\(SPY\): noisy says hi abc/);
  await pickStrategy(page, 'trend_long_short');
  assert.equal(await page.inputValue('input[aria-label="name"]'), '測試: 多空趨勢', '名稱還是範本預設的 → 換成 Python 策略的名稱');
  const shorts = async () => Number((/多 \d+ · 空 (\d+)/.exec(await page.textContent('#results')) || [])[1]);
  await page.click('#run');
  await page.waitForTimeout(1500);
  assert.equal(await shorts(), 0, '沒勾「允許做空」: -1 的部位不會放空');
  await page.check('text=允許做空(策略回傳 -1');
  await page.click('#run');
  await page.waitForFunction(() => /空 [1-9]/.test(document.querySelector('#results')?.textContent || ''), null, { timeout: 60000 });
  assert.ok((await shorts()) > 0, '勾了「允許做空」: 部位 -1 真的放空');
  await context.close();
});

test('手機寬度: Python 策略的設定區不會讓頁面橫向溢出', opts, async () => {
  const { page, context } = await open(withPy, { viewport: { width: 390, height: 800 } });
  await toPython(page);
  await pickStrategy(page, 'sma_cross');
  assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await context.close();
});

test('自訂規則策略(自己寫參數、指標與進出場規則)+ 輸入代號: 下載完成就用這個策略回測;寫錯的規則會標出來', async () => {
  const { page, context, problems } = await open(withPy);
  // 在預設範本上加一個自己的參數與指標,改成自己的進出場規則
  const before = await page.$$eval('input[data-field^="params["][data-field$=".name"]', (els) => els.length);
  await page.click('button:has-text("＋ 新增參數")');
  await page.fill(`input[data-field="params[${before}].name"]`, 'low_rsi');
  await page.fill(`input[data-field="params[${before}].value"]`, '45');
  const inds = await page.$$eval('input[data-field^="indicators["][data-field$=".name"]', (els) => els.length);
  await page.click('button:has-text("＋ 新增指標")');
  await page.fill(`input[data-field="indicators[${inds}].name"]`, 'my_rsi');
  await page.fill(`input[data-field="indicators[${inds}].expr"]`, 'rsi(close, 10)');
  await page.fill('input[data-field="entry.long"]', 'my_rsi < low_rsi');
  await page.fill('input[data-field="exit.long"]', 'my_rsi > 60');
  await page.fill('input[data-field="name"]', '我的 RSI 逢低策略');
  // 輸入代號: 下載完成 → 自動回測
  await download(page, 'AMD');
  await waitResults(page, /我的 RSI 逢低策略.*AMD/);
  const trades = Number((/交易次數(\d+)/.exec(await page.textContent('#results')) || [])[1]);
  assert.ok(trades >= 3, `自訂規則真的產生了交易(${trades})`);
  // 改一個參數 → 結果不同
  const first = await kpis(page);
  await page.fill(`input[data-field="params[${before}].value"]`, '30');
  await page.click('#run');
  await page.waitForFunction((k) => document.querySelector('#results .kpis')?.textContent !== k, first, { timeout: 30000 });
  // 寫錯的規則: 欄位標紅、說明在哪裡,結果頁不會給出錯的數字
  await page.fill('input[data-field="entry.long"]', 'my_rsi <');
  await page.click('#run');
  await page.waitForSelector('#editor-errors:not([hidden])');
  assert.match(await page.textContent('#results'), /策略有 \d+ 個問題/);
  assert.ok(await page.$eval('input[data-field="entry.long"]', (el) => el.classList.contains('invalid')));
  await page.fill('input[data-field="entry.long"]', 'my_rsi < low_rsi');
  await page.click('#run');
  await waitResults(page, /我的 RSI 逢低策略/);
  assert.deepEqual(problems, []);
  await context.close();
});
