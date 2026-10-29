// 真實網路的端對端驗證: 用真的 Chromium 開網站(真的本機伺服器 + 真的 Yahoo),輸入代號 → 下載 → 回測。
// GitHub Actions 的 live-fetch-check 工作流程會跑它;結果以文字印出(也存截圖)。
//   node tools/live_e2e.mjs [截圖資料夾]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const shots = process.argv[2] || '/tmp/shots';
mkdirSync(shots, { recursive: true });
const server = await startServer(resolve(fileURLToPath(new URL('../site', import.meta.url))), 0, { api: {} });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const problems = [], lines = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
let failed = false;
const ok = (cond, label, detail = '') => { lines.push(`${cond ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`); if (!cond) failed = true; };
const status = async () => (await page.textContent('#panel p[role=status]').catch(() => '')) || '';
const search = page.locator('input[aria-label="搜尋標的"]');

await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForSelector('input[placeholder^="輸入代號或公司名稱"]', { timeout: 15000 });
ok(true, '網站偵測到本機伺服器的 /api,搜尋框顯示「輸入代號或公司名稱」');

// 名稱搜尋 → 點結果下載 → 回測
await search.fill('apple');
await page.waitForSelector('[data-testid=net-results] button[aria-label="下載 AAPL"]', { timeout: 20000 });
await page.waitForFunction(() => !/搜尋中/.test(document.querySelector('[data-testid=net-results]')?.textContent || ''), null, { timeout: 20000 });
const found = await page.$$eval('[data-testid=net-results] button', (bs) => bs.map((b) => b.textContent));
lines.push(`INFO 搜尋「apple」: ${JSON.stringify(found)}`);
ok(found.some((t) => /^AAPL/.test(t)), '搜尋「apple」找得到 AAPL');
await page.click('[data-testid=net-results] button[aria-label="下載 AAPL"]');
await page.waitForFunction(() => /已下載 AAPL|下載失敗/.test(document.querySelector('#panel')?.textContent || ''), { timeout: 60000 });
const msg = await status();
lines.push(`INFO ${msg}`);
ok(/已下載 AAPL/.test(msg), '點搜尋結果下載 AAPL');
await page.click('#run');
await page.waitForSelector('.kpis', { timeout: 30000 });
await page.waitForTimeout(1500);
const kpis = await page.$$eval('.kpis .kpi', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
lines.push(`INFO AAPL 回測 KPI: ${JSON.stringify(kpis.slice(0, 6))}`);
ok(kpis.length >= 4 && /AAPL/.test(await page.textContent('#results')), 'AAPL 用預設策略回測,結果頁有 KPI');
await page.screenshot({ path: `${shots}/aapl.png` });

// 直接輸入代號 Enter: 指數、台股、加密貨幣
for (const sym of ['^GSPC', '2330.TW', 'BTC-USD']) {
  await page.click('button:has-text("投資組合")').catch(() => {});
  await search.fill(sym);
  await search.press('Enter');
  await page.waitForFunction((s) => new RegExp(`已下載 ${s.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&')}|下載失敗`).test(document.querySelector('#panel')?.textContent || ''), sym, { timeout: 60000 });
  const m = await status();
  lines.push(`INFO ${m}`);
  ok(new RegExp(`已下載 ${sym.replace(/[.^$*+?()[\]{}|\\]/g, '\\$&')}`).test(m), `輸入 ${sym} 按 Enter 下載`);
}
const chips = await page.$$eval('.chips .chip strong', (els) => els.map((e) => e.textContent));
lines.push(`INFO 目前選取: ${JSON.stringify(chips)}`);
await page.click('#run');
await page.waitForTimeout(3000);
ok(!(await page.textContent('#results')).includes('錯誤'), '四檔組合(AAPL、^GSPC、2330.TW、BTC-USD,日曆不同)回測不報錯');
await page.screenshot({ path: `${shots}/portfolio.png` });

// 找不到
await search.fill('ZZZZNOTREAL');
await search.press('Enter');
await page.waitForFunction(() => /下載失敗/.test(document.querySelector('#panel')?.textContent || ''), { timeout: 30000 });
ok(/找不到代號/.test(await status()), '亂打的代號顯示「找不到」', await status());

// 重新整理後下載的資料還在
await page.reload();
await page.waitForSelector('.picker .sym:text-is("AAPL")', { timeout: 15000 });
ok(true, '重新整理後 AAPL 仍在清單(存在瀏覽器裡)');
ok(problems.length === 0, '沒有 console 錯誤', problems.join(' | '));

await browser.close(); server.close();
console.log(lines.join('\n'));
process.exit(failed ? 1 : 0);
