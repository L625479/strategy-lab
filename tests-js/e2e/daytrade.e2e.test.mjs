// 端對端測試: 「當沖掃描」分頁,在真實的 Chromium 裡操作。資料是合成行情(不是真實行情)。
//   node --test tests-js/e2e/daytrade.e2e.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { startServer } from '../../tools/serve.mjs';
import { buildSite } from './fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const golden = JSON.parse(readFileSync(fixturePath('daytrade_golden.json'), 'utf8'));

let browser, server, url;
before(async () => {
  server = await startServer(buildSite(), 0);
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open({ viewport = { width: 1440, height: 1000 }, noWorker = false } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.dismiss());
  if (noWorker) await page.addInitScript(() => { window.Worker = undefined; });
  await page.goto(url);
  await page.waitForSelector('.kpis');
  await page.click('#tab-dt');
  await page.waitForSelector('#panel-dt .card');
  return { page, context, problems };
}

const loadBuiltin = async (page) => { await page.click('#panel-dt >> text=全選'); await page.click('text=載入選取的標的'); await page.waitForSelector('[data-testid=dt-info]'); };
const loadNpz = async (page) => { await page.setInputFiles('input[aria-label="上傳 npz 面板"]', fixturePath('daytrade_panel.npz')); await page.waitForFunction(() => /14 檔/.test(document.querySelector('[data-testid=dt-info]')?.textContent || '')); };
const runAndWait = async (page, ready) => { await page.click('#dt-run'); await page.waitForSelector(ready, { timeout: 90000 }); await page.waitForFunction(() => !document.querySelector('#dt-run').disabled); };
const useGrid = async (page) => { await page.click('#panel-dt button:has-text("規則網格")'); await page.click('button:has-text("載入標準網格")'); };
const setNumber = (page, label, value) => page.fill(`input[aria-label="${label}"]`, String(value));
const rulesRows = (page) => page.locator('section.card', { has: page.locator('h2', { hasText: '全部規則' }) }).locator('tbody tr');
const waitRows = async (page, n) => {
  for (let i = 0; i < 60; i++) { if ((await rulesRows(page).count()) === n) return; await page.waitForTimeout(100); }
  assert.equal(await rulesRows(page).count(), n);
};
const summaryRows = (page) => page.$$eval('section.card:has(h2:text-is("掃描結果")) tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent)));

test('分頁: 切換、記住上次的分頁、沒有任何 console 錯誤', async () => {
  const { page, context, problems } = await open();
  assert.equal(await page.isVisible('#app-dt'), true);
  assert.equal(await page.isVisible('#app-bt'), false);
  assert.match(await page.textContent('#results-dt'), /當沖規則掃描/);
  await page.reload();
  await page.waitForSelector('#panel-dt .card');
  assert.equal(await page.isVisible('#app-dt'), true, '重新整理後停在當沖分頁');
  await page.click('#tab-bt');
  await page.waitForSelector('.kpis');
  assert.equal(await page.isVisible('#app-dt'), false);
  assert.deepEqual(problems, []);
  await context.close();
});

test('沒有載入資料就執行: 提示先載入', async () => {
  const { page, context } = await open();
  await page.click('#dt-run');
  assert.match(await page.textContent('#results-dt'), /請先在左邊載入資料/);
  await context.close();
});

test('單一規則(內建標的): 明細、分佈圖、holdout 預設不揭曉,取消不會被計次,確認後才算', async () => {
  const { page, context, problems } = await open();
  await loadBuiltin(page);
  assert.match(await page.textContent('[data-testid=dt-info]'), /5 檔 · 2,023 個交易日/);
  assert.match(await page.textContent('#panel-dt'), /BTC-USD\(800 根\)/, '週末的 K 棒被略過時要說出來');
  await page.selectOption('select[aria-label="範本"]', 'baseline');
  await runAndWait(page, '[data-testid=dt-status]');
  const body = await page.textContent('#results-dt');
  assert.match(body, /5 檔 × 1 條規則/);
  assert.match(body, /Holdout\(2021-06-01 起\)未被使用/);
  assert.match(body, /Holdout 還沒有被查看過/);
  await page.waitForSelector('svg[aria-label="每筆淨報酬的分佈"] rect', { state: 'attached' });
  assert.ok((await page.$$('svg[aria-label="每筆淨報酬的分佈"] rect')).length > 10);
  assert.doesNotMatch(body, /holdout\(保守\)/, '沒按按鈕之前看不到 holdout');

  // 取消確認視窗 → 不揭曉、不計次
  await page.click('button:has-text("看這條規則的 holdout")');
  assert.doesNotMatch(await page.textContent('#results-dt'), /holdout\(保守\)/);
  // 確認 → 揭曉並記錄
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => { assert.match(d.message(), /留給最後驗證/); d.accept(); });
  await page.click('button:has-text("看這條規則的 holdout")');
  await page.waitForSelector('text=holdout 2 倍成本');
  assert.match(await page.textContent('#results-dt'), /已經被查看 1 次/);
  assert.match(await page.textContent('#results-dt'), /D4 holdout 仍通過 D1–D3/);
  // 重新整理再跑: 看過的次數還在
  await page.reload();
  await page.waitForSelector('#panel-dt .card');
  await loadBuiltin(page);
  await runAndWait(page, '[data-testid=dt-status]');
  assert.match(await page.textContent('#results-dt'), /已經被查看 1 次/);
  page.once('dialog', (d) => { assert.match(d.message(), /已經看過 1 次/); d.dismiss(); });
  await page.click('button:has-text("看這條規則的 holdout")');
  assert.deepEqual(problems, []);
  await context.close();
});

test('規則網格(內建標的): 通過數統計、散佈圖、可行邊界、規則表、CSV 下載', async () => {
  const { page, context, problems } = await open();
  await loadBuiltin(page);
  await useGrid(page);
  assert.match(await page.textContent('#dt-grid-status'), /條件 14 × 進場 6 × 出場 7 = 588 條規則/);
  await runAndWait(page, 'text=全部規則(');
  const rows = await summaryRows(page);
  assert.equal(rows.length, 2);
  assert.match(rows[0][0], /保守/); assert.match(rows[1][0], /樂觀/);
  assert.ok(rows.every((r) => r.slice(1).every((c) => /^\d+ \/ 588$/.test(c))));
  assert.match(await page.textContent('#results-dt'), /樂觀算法下有 \d+ 條「全過」/, '限價 + 停利的樂觀算法會產生假象,要明說');
  assert.ok((await page.$$('svg[aria-label^="規則散佈圖"] circle')).length > 80);

  // 點散佈圖上的一個點 → 明細
  const box = await page.locator('svg[aria-label^="規則散佈圖"] circle').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('h2:text-is("規則明細")');
  // 規則表: 預設只列「多數個股有足夠筆數」的規則;取消勾選後才看得到全部 588 條
  const total = Number((/全部規則\((\d+) 條\)/.exec(await page.textContent('#results-dt')) || [])[1]);
  assert.ok(total > 0 && total < 588, `預設有篩掉筆數不足的規則(${total})`);
  await page.uncheck('text=只看多數個股有足夠筆數的規則');
  await page.waitForFunction(() => /全部規則\(588 條\)/.test(document.querySelector('#results-dt').textContent));
  await page.fill('input[aria-label="篩選規則"]', 'short|rsi2>90|lim1atr');
  await waitRows(page, 7);
  await page.selectOption('select[aria-label="方向"]', 'long');
  await waitRows(page, 0);
  // CSV
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("下載全部規則的結果")')]);
  const csv = readFileSync(await dl.path(), 'utf8').trim().split('\n');
  assert.equal(csv.length, 589);
  assert.match(csv[0], /^rule,side,n,days,win,mean,/);
  assert.match(csv[1], /^long\|none\|open\|close,long,/);
  assert.deepEqual(problems, []);
  await context.close();
});

test('.npz 面板: 掃描結果與使用者的 Python 程式(合成面板上)逐項相同', async () => {
  const { page, context, problems } = await open();
  await page.click('#panel-dt button:has-text("上傳 .npz 面板")');
  await loadNpz(page);
  assert.match(await page.textContent('[data-testid=dt-info]'), /14 檔 · 1,300 個交易日 · 2016-01-04 ~ .* 外部序列: \^VIX/);
  await useGrid(page);
  await page.fill('input[aria-label="holdout 起始日"]', golden.holdout_start);
  await page.dispatchEvent('input[aria-label="holdout 起始日"]', 'change');
  await setNumber(page, 'devMin', 5); await setNumber(page, 'holdMin', 2);
  await runAndWait(page, 'text=全部規則(');
  assert.match(await page.textContent('[data-testid=dt-status]'), /14 檔 × 588 條規則/);
  const rows = await summaryRows(page);
  const want = golden.selection;
  const fmt = (c) => [c.D1, c.D2, c.D1D2, c.D3, c.all].map((v) => `${v} / ${c.total}`);
  assert.deepEqual(rows[0].slice(1), fmt(want.dev.counts), '保守: D1 / D2 / D1+D2 / D3 / 全過');
  assert.deepEqual(rows[1].slice(1), fmt(want.dev_optimistic.counts), '樂觀');
  // 候選: 使用者的 candidates() 選出的規則
  const cands = await page.$$eval('section.card:has(h2:text-is("候選")) tbody tr', (rs) => rs.map((r) => r.querySelector('code').textContent));
  assert.deepEqual(cands, Object.values(want.dev.candidates));
  // 單一規則的筆數與勝率
  await page.fill('input[aria-label="篩選規則"]', 'long|none|open|close');
  await waitRows(page, 1);
  const cells = await page.$$eval('section.card:has(h2:has-text("全部規則")) tbody tr td', (tds) => tds.map((t) => t.textContent));
  const py = golden.rules.find((r) => r.rule === 'long|none|open|close').dev_cons;
  assert.equal(cells[1], py.n.toLocaleString('en-US'));
  assert.equal(cells[2], `${(py.win * 100).toFixed(1)}%`);
  assert.equal(cells[3], `${py.mean >= 0 ? '+' : ''}${(py.mean * 100).toFixed(2)}%`);
  assert.deepEqual(problems, []);
  await context.close();
});

test('.npz 面板: 看 holdout 的數字與 Python 相同', async () => {
  const { page, context } = await open();
  await page.click('#panel-dt button:has-text("上傳 .npz 面板")');
  await loadNpz(page);
  await page.click('#panel-dt button:has-text("規則網格")');
  await page.click('button:has-text("小型範例")');
  await page.fill('input[aria-label="holdout 起始日"]', golden.holdout_start);
  await page.dispatchEvent('input[aria-label="holdout 起始日"]', 'change');
  await setNumber(page, 'devMin', 5); await setNumber(page, 'holdMin', 2);
  await runAndWait(page, 'text=全部規則(');
  await page.fill('input[aria-label="篩選規則"]', 'long|gap<=-1atr|open|tp1%');
  await waitRows(page, 1);
  await page.click('section.card:has(h2:has-text("全部規則")) tbody button.link');
  await page.waitForSelector('h2:text-is("規則明細")');
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => d.accept());
  await page.click('button:has-text("看這條規則的 holdout")');
  await page.waitForSelector('text=holdout 2 倍成本');
  const tbl = await page.$$eval('section.card:has(h2:text-is("規則明細")) .tbl-wrap:has-text("holdout 2 倍成本") tbody tr', (rs) => rs.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent)));
  const py = golden.rules.find((r) => r.rule === 'long|gap<=-1atr|open|tp1%');
  const line = (s) => [s.n.toLocaleString('en-US'), `${(s.win * 100).toFixed(1)}%`];
  assert.deepEqual(tbl[0].slice(1, 3), line(py.dev_cons));
  assert.deepEqual(tbl[1].slice(1, 3), line(py.hold_cons));
  assert.deepEqual(tbl[2].slice(1, 3), line(py.hold_2x));
  assert.deepEqual(tbl[3].slice(1, 3), line(py.hold_opt));
  await context.close();
});

test('多個 CSV: 代號取自檔名,惡意檔名與規則名稱只當文字顯示', async () => {
  const { page, context } = await open();
  await page.click('#panel-dt button:has-text("上傳多個 CSV")');
  const csv = (seed) => {
    let s = seed, p = 100;
    const rows = ['date,open,high,low,close'];
    for (let i = 0; i < 260; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const o = p * (1 + ((s / 4294967296) - 0.5) * 0.02), c = o * (1 + (((s >>> 8) / 16777216) - 0.5) * 0.03);
      rows.push(`${new Date(Date.UTC(2023, 0, 2 + i)).toISOString().slice(0, 10)},${o},${Math.max(o, c) * 1.004},${Math.min(o, c) * 0.996},${c}`);
      p = c;
    }
    return Buffer.from(rows.join('\n'));
  };
  await page.setInputFiles('input[aria-label="上傳多個 CSV"]', [
    { name: 'AAA.csv', mimeType: 'text/csv', buffer: csv(1) },
    { name: '<img src=x onerror=window.__x=1>.csv', mimeType: 'text/csv', buffer: csv(2) },
    { name: 'broken.csv', mimeType: 'text/csv', buffer: Buffer.from('foo,bar\n1,2') },
  ]);
  await page.waitForSelector('[data-testid=dt-info]');
  assert.match(await page.textContent('[data-testid=dt-info]'), /2 檔/);
  assert.match(await page.textContent('#panel-dt'), /1 個檔案無法讀取/);
  await page.click('#panel-dt button:has-text("規則網格")');
  const evil = JSON.stringify({ name: '<img src=x onerror=window.__x=1>', setups: [{ side: 'long', name: '<b>x</b>', expr: 'true' }], entries: [{ name: 'open', expr: '' }], exits: [{ name: 'close', expr: '' }] });
  await page.fill('textarea[aria-label="規則網格 JSON"]', evil);
  await setNumber(page, 'devMin', 5);
  await page.fill('input[aria-label="holdout 起始日"]', '2023-11-01');
  await page.dispatchEvent('input[aria-label="holdout 起始日"]', 'change');
  await runAndWait(page, '[data-testid=dt-status]');
  assert.match(await page.textContent('[data-testid=dt-status]'), /<img src=x onerror=window.__x=1>/);
  assert.equal(await page.evaluate(() => window.__x), undefined);
  assert.equal((await page.$$('#results-dt img')).length, 0);
  await context.close();
});

test('錯誤: 規則寫錯標在欄位旁、網格 JSON 壞掉有提示,都不會當掉', async () => {
  const { page, context, problems } = await open();
  await loadBuiltin(page);
  await page.fill('input[data-field="setup"]', 'close >');
  await runAndWait(page, '#results-dt .errors');
  assert.match(await page.textContent('#results-dt'), /規則有 1 個問題/);
  assert.match(await page.textContent('#panel-dt'), /規則在這裡突然結束/);
  assert.equal(await page.$eval('input[data-field="setup"]', (e) => e.classList.contains('invalid')), true);
  await page.fill('input[data-field="setup"]', 'true');
  await page.click('#panel-dt button:has-text("規則網格")');
  await page.fill('textarea[aria-label="規則網格 JSON"]', '{ 壞掉的 json');
  assert.match(await page.textContent('#dt-grid-status'), /不是有效的 JSON/);
  await page.click('#dt-run');
  await page.waitForSelector('#results-dt .errors');
  assert.match(await page.textContent('#results-dt'), /網格不是有效的 JSON/);
  await page.fill('textarea[aria-label="規則網格 JSON"]', JSON.stringify({ setups: [{ side: 'long', name: 'a', expr: 'ghost > 1' }], entries: [{ name: 'open', expr: '' }], exits: [{ name: 'close', expr: '' }] }));
  assert.match(await page.textContent('#dt-grid-status'), /ghost/);
  assert.deepEqual(problems.filter((p) => !/Failed to load resource/.test(p)), []);
  await context.close();
});

test('設定與規則記在這個瀏覽器裡,重新整理後還在', async () => {
  const { page, context } = await open();
  await page.fill('input[data-field="setup"]', 'open / close - 1 <= -2 * atrp');
  await setNumber(page, 'winPct', 75);
  await page.reload();
  await page.waitForSelector('#panel-dt .card');
  assert.equal(await page.inputValue('input[data-field="setup"]'), 'open / close - 1 <= -2 * atrp');
  assert.equal(await page.inputValue('input[aria-label="winPct"]'), '75');
  await context.close();
});

test('瀏覽器不支援 Worker 時退回主執行緒,結果照樣出來', async () => {
  const { page, context, problems } = await open({ noWorker: true });
  await loadBuiltin(page);
  await page.selectOption('select[aria-label="範本"]', 'baseline');
  await runAndWait(page, '[data-testid=dt-status]');
  assert.match(await page.textContent('#results-dt'), /5 檔 × 1 條規則/);
  assert.deepEqual(problems, []);
  await context.close();
});

test('手機寬度: 當沖分頁沒有橫向捲動', async () => {
  const { page, context } = await open({ viewport: { width: 390, height: 844 } });
  await loadBuiltin(page);
  await useGrid(page);
  await runAndWait(page, 'text=全部規則(');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `橫向溢出 ${over}px`);
  await context.close();
});
