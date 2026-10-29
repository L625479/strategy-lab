// 端對端測試: 「當沖掃描」分頁的盤中 K 線驗證,在真實的 Chromium 裡操作。
// 資料是合成的盤中 K 棒(tests-js/fixtures/intraday_*.npz,搭配 daytrade_panel.npz),標準答案來自使用者的 Python 程式。
//   node --test tests-js/e2e/intraday.e2e.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { startServer } from '../../tools/serve.mjs';
import { buildSite } from './fixture.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const fixturePath = (name) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const golden = JSON.parse(readFileSync(fixturePath('intraday_golden.json'), 'utf8'));

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

const loadPanel = async (page) => {
  await page.click('#panel-dt button:has-text("上傳 .npz 面板")');
  await page.setInputFiles('input[aria-label="上傳 npz 面板"]', fixturePath('daytrade_panel.npz'));
  await page.waitForFunction(() => /14 檔/.test(document.querySelector('[data-testid=dt-info]')?.textContent || ''));
};
const loadIntra = async (page, which, expect) => {
  await page.setInputFiles(`input[aria-label="上傳 ${which === '60m' ? '60' : '5'} 分 K npz"]`, fixturePath(`intraday_${which}.npz`));
  await page.waitForFunction(([w, re]) => new RegExp(re).test(document.querySelector(`[data-testid=dt-intra-${w}]`)?.textContent || ''), [which, expect]);
};
const useGrid = async (page) => { await page.click('#panel-dt button:has-text("規則網格")'); await page.click('button:has-text("載入標準網格")'); };
const setNumber = (page, label, value) => page.fill(`input[aria-label="${label}"]`, String(value));
const runIntraday = async (page) => { await page.click('#dt-run-intra'); await page.waitForSelector('[data-testid=dt-istatus]', { timeout: 90000 }); await page.waitForFunction(() => !document.querySelector('#dt-run').disabled); };
const cardText = (page, title) => page.textContent(`section.card:has(h2:has-text("${title}"))`);
const summaryRows = (page) => page.$$eval('section.card:has(h2:has-text("掃描結果")) tbody tr', (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent)));
const pctText = (x, d = 1, sign = false) => `${sign && x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;

test('盤中驗證的完整流程: 載入 → I1 掃描 → 看不到 I2 → 確認要明確按下 → 結果與 Python 相同 → 次數會記住', async () => {
  const { page, context, problems } = await open();
  assert.match(await page.textContent('#panel-dt'), /盤中 K 線\(選用/);
  await loadPanel(page);
  await loadIntra(page, '60m', '161 個交易日可用');
  const status60 = await page.textContent('[data-testid=dt-intra-60m]');
  assert.match(status60, /2 天不在日線日曆上,已略過/);
  assert.match(status60, /7 根\/天/);
  assert.match(status60, /14 \/ 14 檔對上日線面板/);
  assert.match(await page.textContent('[data-testid=dt-intra-5m]'), /尚未載入/);

  await useGrid(page);
  await runIntraday(page);
  const py = golden.protocols.strict;
  const status = await page.textContent('[data-testid=dt-istatus]');
  assert.match(status, /14 檔 × 588 條規則/);
  assert.ok(status.includes(`I1 ${py.i1_range[0]} → ${py.i1_range[1]}(${golden.half} 個交易日)`), status);
  assert.ok(status.includes(`I2(${py.i2_range[0]} → ${py.i2_range[1]})與 5 分 K 未被使用`), status);

  // 通過數: 與他的 run_daytrade.intraday() 印出的第一行相同
  const rows = await summaryRows(page);
  const counts = (key) => new RegExp(`\\[${key}\\] 588 條中 H1 過 (\\d+)、H2 過 (\\d+)、H1\\+H2 同時過 (\\d+)、H3 過 (\\d+)、全過 (\\d+)`).exec(py.scan_text).slice(1).map((v) => `${v} / 588`);
  assert.deepEqual(rows[0].slice(1), counts('i1'));
  assert.deepEqual(rows[1].slice(1), counts('i1_optimistic'));
  assert.match(await cardText(page, '掃描結果'), /同一根 K 棒/, '樂觀與保守的差距要說明成因(同一根 K 棒裡的先後)');

  // 存活候選與候選
  assert.match(await page.textContent('#results-dt'), new RegExp(`存活候選\\(${py.live.length} 條\\)`));
  const cands = await page.$$eval('section.card:has(h2:text-is("候選")) tbody tr', (rs) => rs.map((r) => r.querySelector('code').textContent));
  assert.deepEqual(cands, Object.values(py.candidates));

  // I2 與 5 分 K 還沒揭曉:沒有結果表,按鈕因為沒有 5 分 K 檔而不能按
  assert.equal(await page.locator('[data-testid=dt-confirm-table]').count(), 0);
  assert.equal(await page.isDisabled('#dt-confirm'), true);
  assert.match(await cardText(page, '確認(I2 與 5 分 K)'), /還需要 5 分 K 檔/);
  assert.match(await cardText(page, '確認(I2 與 5 分 K)'), new RegExp(`共 ${py.confirm_order.length} 條規則`));

  // 載入 5 分 K 不會洗掉 I1 的結果
  await loadIntra(page, '5m', '45 個交易日可用');
  assert.equal(await page.locator('[data-testid=dt-istatus]').count(), 1);
  assert.equal(await page.isDisabled('#dt-confirm'), false);
  assert.match(await cardText(page, '確認(I2 與 5 分 K)'), /還沒有被查看過/);

  // 取消 → 不揭曉
  await page.click('#dt-confirm');
  assert.equal(await page.locator('[data-testid=dt-confirm-table]').count(), 0);
  assert.match(await cardText(page, '確認(I2 與 5 分 K)'), /還沒有被查看過/, '取消不計次');
  // 確認 → 揭曉
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => { assert.match(d.message(), /留給最後確認/); d.accept(); });
  await page.click('#dt-confirm');
  await page.waitForSelector('[data-testid=dt-confirm-table]');
  const table = await page.$$eval('[data-testid=dt-confirm-table] tbody tr', (rs) => rs.map((r) => [r.dataset.key, ...[...r.querySelectorAll('td')].map((c) => c.textContent)]));
  assert.deepEqual(table.map((r) => r[0]), py.confirm_order, '規則與順序 = 存活候選 + 候選');
  assert.match(await page.textContent('section.card:has([data-testid=dt-confirm-table]) h2'), new RegExp(`確認結果: 0 / ${py.confirm_order.length} 條合格`), '他的原始門檻下沒有規則合格');
  assert.ok(table.every((r) => /不合格/.test(r[2])));
  // 抽幾條比對 I2 / 5 分 K 的勝率與平均(格式 "勝率 / 平均")
  for (const key of [py.confirm_order[0], py.confirm_order.at(-1), 'long|none|lim1atr|tp3%']) {
    const want = py.confirm[key], row = table.find((r) => r[0] === key);
    if (!row) continue;
    const u = (packed) => ({ win: packed[2], mean: packed[3] });
    const fmt = (packed) => `${pctText(u(packed).win)} / ${pctText(u(packed).mean, 2, true)}`;
    assert.equal(row[5], fmt(want.i2), `${key} I2 保守`);
    assert.equal(row[6], fmt(want.i2_opt), `${key} I2 樂觀`);
    assert.equal(row[7], fmt(want.i2_2x), `${key} I2 兩倍成本`);
    assert.equal(row[8], fmt(want.m5), `${key} 5 分 K 保守`);
    assert.equal(row[9], fmt(want.m5_opt), `${key} 5 分 K 樂觀`);
  }
  assert.match(await cardText(page, '確認結果'), /已經被查看 1 次/);

  // 規則明細:揭曉後多出 I2 與 5 分 K 的列和不合格的原因
  await page.click(`[data-testid=dt-confirm-table] tbody tr:first-child button.link`);
  await page.waitForSelector('h2:text-is("規則明細")');
  const detail = await cardText(page, '規則明細');
  for (const label of ['I1 保守', 'I1 樂觀', 'I2 保守', 'I2 樂觀', 'I2 兩倍成本', '5 分 K 保守', '5 分 K 樂觀']) assert.ok(detail.includes(label), label);
  assert.match(detail, /不合格的原因/);

  // CSV
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('section.card:has([data-testid=dt-confirm-table]) button:has-text("下載")')]);
  const csv = readFileSync(await dl.path(), 'utf8').trim().split('\n');
  assert.equal(csv.length, py.confirm_order.length + 1);
  assert.match(csv[0], /^rule,live,qualified,i1_n,i1_win,i1_mean,i2_n/);

  // 重新整理後再載入同樣的檔案: 看過的次數還在,再看會被提醒
  await page.reload();
  await page.waitForSelector('#panel-dt .card');
  await loadPanel(page);
  await loadIntra(page, '60m', '161 個交易日可用');
  await loadIntra(page, '5m', '45 個交易日可用');
  await useGrid(page);
  await runIntraday(page);
  assert.match(await cardText(page, '確認(I2 與 5 分 K)'), /已經被查看 1 次/);
  let msg = '';
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => { msg = d.message(); d.dismiss(); });
  await page.click('#dt-confirm');
  assert.match(msg, /已經看過 1 次/);
  assert.equal(await page.locator('[data-testid=dt-confirm-table]').count(), 0, '提醒後取消 → 不揭曉');
  assert.deepEqual(problems, []);
  await context.close();
});

test('放寬門檻: 存活候選、候選與合格的規則與 Python 相同', async () => {
  const { page, context, problems } = await open();
  await loadPanel(page);
  await loadIntra(page, '60m', '161 個交易日可用');
  await loadIntra(page, '5m', '45 個交易日可用');
  await useGrid(page);
  await setNumber(page, 'winPct', 60); await setNumber(page, 'meanPct', 0.2);
  await runIntraday(page);
  const py = golden.protocols.loose;
  assert.match(await page.textContent('#results-dt'), new RegExp(`存活候選\\(${py.live.length} 條\\)`));
  const cands = await page.$$eval('section.card:has(h2:text-is("候選")) tbody tr', (rs) => rs.map((r) => r.querySelector('code').textContent));
  assert.deepEqual(cands, Object.values(py.candidates));
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => d.accept());
  await page.click('#dt-confirm');
  await page.waitForSelector('[data-testid=dt-confirm-table]');
  const verdicts = await page.$$eval('[data-testid=dt-confirm-table] tbody tr', (rs) => rs.map((r) => [r.dataset.key, /✓ 合格/.test(r.children[1].textContent)]));
  assert.deepEqual(verdicts, py.confirm_order.map((k) => [k, py.confirm[k].qualified]));
  const nQ = verdicts.filter((v) => v[1]).length;
  assert.ok(nQ >= 5);
  assert.match(await page.textContent('section.card:has([data-testid=dt-confirm-table]) h2'), new RegExp(`確認結果: ${nQ} / ${py.confirm_order.length} 條合格`));
  // 不合格的原因寫在 title 上(滑過判定可以看到)
  const reason = await page.$$eval('[data-testid=dt-confirm-table] tbody tr', (rs) => rs.map((r) => r.children[1].title).find(Boolean));
  assert.ok(reason, '至少有一條不合格並寫出原因');
  assert.deepEqual(problems, []);
  await context.close();
});

test('錯誤處理: 沒載入日線 / 沒載入 60 分 K / 盤中檔和日線面板對不起來', async () => {
  const { page, context, problems } = await open();
  await page.click('#dt-run-intra');
  assert.match(await page.textContent('#results-dt'), /請先在左邊載入日線資料/);
  await loadPanel(page);
  await page.click('#dt-run-intra');
  assert.match(await page.textContent('#results-dt'), /請先在「資料」區塊載入 60 分 K 檔/);
  // 兩檔、代號 A B 的盤中檔,日線面板裡沒有這兩個代號
  await page.setInputFiles('input[aria-label="上傳 60 分 K npz"]', fixturePath('intraday_ok_small.npz'));
  await page.waitForSelector('#panel-dt .errors');
  assert.match(await page.textContent('#panel-dt .errors'), /intraday_ok_small\.npz.*沒有任何交集/);
  assert.match(await page.textContent('[data-testid=dt-intra-60m]'), /尚未載入/);
  // 格式錯誤
  await page.setInputFiles('input[aria-label="上傳 5 分 K npz"]', fixturePath('intraday_badshape.npz'));
  await page.waitForFunction(() => /L 的形狀/.test(document.querySelector('#panel-dt .errors')?.textContent || ''));
  assert.deepEqual(problems.filter((p) => !/Failed to load resource/.test(p)), []);
  await context.close();
});

test('不支援 Worker 的瀏覽器: 退回主執行緒也能跑完整個流程', async () => {
  const { page, context, problems } = await open({ noWorker: true });
  await loadPanel(page);
  await loadIntra(page, '60m', '161 個交易日可用');
  await loadIntra(page, '5m', '45 個交易日可用');
  await page.click('#panel-dt button:has-text("規則網格")');
  await page.click('button:has-text("小型範例")');
  await runIntraday(page);
  assert.match(await page.textContent('[data-testid=dt-istatus]'), /14 檔 × 27 條規則/);
  assert.deepEqual(problems, []);
  await context.close();
});

test('手機寬度: 確認表在自己的捲動區裡,頁面不會橫向溢出', async () => {
  const { page, context } = await open({ viewport: { width: 390, height: 800 } });
  await loadPanel(page);
  await loadIntra(page, '60m', '161 個交易日可用');
  await loadIntra(page, '5m', '45 個交易日可用');
  await page.click('#panel-dt button:has-text("規則網格")');
  await page.click('button:has-text("載入標準網格")');
  await runIntraday(page);
  page.removeAllListeners('dialog');
  page.once('dialog', (d) => d.accept());
  await page.click('#dt-confirm');
  await page.waitForSelector('[data-testid=dt-confirm-table]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `頁面橫向溢出 ${overflow}px`);
  await context.close();
});
