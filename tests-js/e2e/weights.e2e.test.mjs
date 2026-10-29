// 端對端測試: 「目標權重(槓桿)」分頁,在真實的 Chromium 裡操作。資料是合成行情(不是真實行情)。
//   node --test tests-js/e2e/weights.e2e.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { priceFileName, toBars } from '../../site/js/engine/data.js';
import { buildWeightsData, compileWeights } from '../../site/js/engine/weights.js';
import { runWeights } from '../../site/js/engine/weightsrun.js';
import { getWeightsTemplate } from '../../site/js/engine/weightsTemplates.js';
import { startServer } from '../../tools/serve.mjs';
import { buildSite } from './fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

let browser, server, url, siteDir;
before(async () => {
  siteDir = buildSite();
  server = await startServer(siteDir, 0);
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function open({ viewport = { width: 1440, height: 1000 } } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('.kpis');
  await page.click('#tab-w');
  await page.waitForSelector('#panel-w .card');
  return { page, context, problems };
}

const runAndWait = async (page, ready = '[data-testid=w-status]') => { await page.click('#w-run'); await page.waitForSelector(ready, { timeout: 30000 }); await page.waitForFunction(() => !document.querySelector('#w-run').disabled); };
const useTemplate = async (page, id) => { await page.selectOption('select[aria-label="範本"]', id); };
const kpis = (page) => page.$$eval('#results-w .kpi', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.lbl').textContent, e.querySelector('.val').textContent])));
const bars = (id) => toBars(JSON.parse(readFileSync(join(siteDir, 'data', 'prices', `${priceFileName(id)}.json`), 'utf8')));
const hasInk = (page, sel) => page.$eval(sel, (box) => [...box.querySelectorAll('canvas')].some((c) => {
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && ++n > 200) return true;
  return false;
}));

test('分頁: 開啟、空狀態、重新整理後停在這個分頁、沒有 console 錯誤', async () => {
  const { page, context, problems } = await open();
  assert.match(await page.textContent('#results-w'), /目標權重策略/);
  assert.equal(await page.isVisible('#app-w'), true);
  await page.reload();
  await page.waitForSelector('#panel-w .card');
  assert.equal(await page.isVisible('#app-w'), true);
  assert.deepEqual(problems, []);
  await context.close();
});

test('內建清單沒有的標的(預設範本用 GOOG): 友善的錯誤,不會當掉', async () => {
  const { page, context } = await open();
  await page.click('#w-run');
  await page.waitForSelector('#results-w .errors');
  assert.match(await page.textContent('#results-w .errors'), /沒有 GOOG 的價格資料/);
  await context.close();
});

test('波動目標範本(SPY + 利率序列): 結果與直接呼叫引擎完全相同,圖表有內容', async () => {
  const { page, context, problems } = await open();
  await useTemplate(page, 'vol_target');
  await runAndWait(page);
  const k = await kpis(page);
  assert.deepEqual(Object.keys(k), ['總報酬', '年化報酬 (CAGR)', '夏普比率', '最大回撤', '年化波動', '平均曝險', '使用融資的日子', '成交筆數']);
  const t = getWeightsTemplate('vol_target').strategy;
  const c = compileWeights(t).compiled;
  const r = runWeights(c, buildWeightsData(c, { SPY: bars('SPY'), '^IRX': bars('^IRX') }), { capital: 100000 });
  const p = (x, d = 1) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
  assert.equal(k['總報酬'], p(r.metrics.totalReturn));
  assert.equal(k['年化報酬 (CAGR)'], p(r.metrics.cagr));
  assert.equal(k['最大回撤'], `${(r.metrics.maxDrawdown * 100).toFixed(1)}%`);
  assert.equal(k['成交筆數'], String(r.account.fills));
  assert.equal(k['平均曝險'], `${r.account.avgGross.toFixed(2)}×`);
  await page.waitForTimeout(600);
  for (const sel of ['#results-w .chart.eq', '#results-w .chart.dd']) assert.ok(await hasInk(page, sel), `${sel} 應該有畫出東西`);
  assert.equal((await page.$$('#results-w .chart')).length, 3);
  assert.match(await page.textContent('#results-w'), /融資利息/);
  assert.match(await page.textContent('#results-w'), new RegExp(`每一次調整\\(${r.account.fills} 筆\\)`));
  assert.deepEqual(problems, []);
  await context.close();
});

test('槓桿的代價: 固定 1.5 倍 → 平均曝險 1.5×、幾乎天天用融資、付融資利息;買進持有 1 倍 → 不用融資', async () => {
  const { page, context } = await open();
  await useTemplate(page, 'fixed_lev');
  await runAndWait(page);
  let k = await kpis(page);
  assert.match(k['平均曝險'], /^1\.4\d×$|^1\.50×$/);
  assert.ok(parseInt(k['使用融資的日子'], 10) >= 95);
  const acct = await page.$$eval('section.card:has(h2:text-is("帳戶明細(整段期間)")) tbody tr', (rs) => rs.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent)));
  assert.equal(acct[0][0], '融資利息'); assert.ok(Number(acct[0][1].replace(/,/g, '')) > 0);
  assert.ok(Number(acct[1][1].replace(/,/g, '')) >= 0);
  await useTemplate(page, 'buy_hold');
  await runAndWait(page);
  k = await kpis(page);
  assert.match(k['平均曝險'], /^0\.99×$|^1\.00×$/);
  assert.equal(k['使用融資的日子'], '0%');
  await context.close();
});

test('carryIn: 預設從資料開頭跑,開始日之後沒有「建倉」;取消勾選則在開始日當天重新開始', async () => {
  const { page, context } = await open();
  await useTemplate(page, 'trend_gate');
  await page.fill('input[aria-label="開始日"]', '2022-01-03');
  await page.dispatchEvent('input[aria-label="開始日"]', 'change');
  await runAndWait(page);
  const firstFill = () => page.$eval('section.card:has(h2:has-text("每一次調整")) tbody tr td', (e) => e.textContent);
  const carry = await firstFill();
  assert.ok(carry >= '2022-01-03', `預設: 第一筆調整在開始日之後(${carry})`);
  assert.match(await page.textContent('[data-testid=w-status]'), /策略從資料開頭就在跑/);
  await page.uncheck('text=策略從資料開頭就開始跑');
  await runAndWait(page);
  assert.match(await page.textContent('[data-testid=w-status]'), /從開始日空手開始/);
  assert.ok((await firstFill()) >= '2022-01-03');
  await context.close();
});

test('編輯權重運算式: 錯誤標在欄位旁;改對之後可以跑;記在瀏覽器裡', async () => {
  const { page, context, problems } = await open();
  await useTemplate(page, 'buy_hold');
  await page.fill('#panel-w input[data-field="weights[0].expr"]', 'min(2, ghost_close');
  await page.click('#w-run');
  await page.waitForSelector('#results-w .errors');
  assert.match(await page.textContent('#panel-w'), /括號|缺少|不認得|結束/);
  assert.equal(await page.$eval('#panel-w input[data-field="weights[0].expr"]', (e) => e.classList.contains('invalid')), true);
  await page.fill('#panel-w input[data-field="weights[0].expr"]', 'ifelse(spy_close > sma(spy_close, 50), 1.2, 0)');
  await page.fill('#panel-w input[data-field="name"]', '我的趨勢策略');
  await page.click('#panel-w button:has-text("新增序列")');
  await page.reload();
  await page.waitForSelector('#panel-w .card');
  assert.equal(await page.inputValue('#panel-w input[data-field="weights[0].expr"]'), 'ifelse(spy_close > sma(spy_close, 50), 1.2, 0)');
  assert.equal(await page.inputValue('#panel-w input[data-field="name"]'), '我的趨勢策略');
  assert.equal((await page.$$('#panel-w input[data-field$=".name"][data-field^="series"]')).length, 2);
  assert.deepEqual(problems.filter((x) => !/Failed to load resource/.test(x)), []);
  await context.close();
});

test('手機寬度: 目標權重分頁沒有橫向捲動', async () => {
  const { page, context } = await open({ viewport: { width: 390, height: 844 } });
  await useTemplate(page, 'vol_target');
  await runAndWait(page);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 1, `橫向溢出 ${over}px`);
  await context.close();
});
