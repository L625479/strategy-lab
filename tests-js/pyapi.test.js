// 本機伺服器的 /api/py: 用「真的 Python」執行 strategies_py 風格的策略。沒有 Python 或 pandas 的環境會略過這些測試。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { after, test } from 'node:test';

import { runBacktest } from '../site/js/engine/backtest.js';
import { runPortfolio } from '../site/js/engine/portfolio.js';
import { signalsFromPython } from '../site/js/engine/pystrategy.js';
import { compileStrategy, computeSignals, emptyStrategy } from '../site/js/engine/strategy.js';
import { startServer } from '../tools/serve.mjs';
import { randomWalk } from './helpers.js';

const DIR = new URL('./fixtures/py_strategies', import.meta.url).pathname;
const SITE = new URL('../site', import.meta.url).pathname;
const hasPython = (() => { for (const py of ['python3', 'python']) { try { execFileSync(py, ['-c', 'import pandas, numpy'], { stdio: 'ignore' }); return true; } catch { /* 試下一個 */ } } return false; })();
const opts = { skip: hasPython ? false : '需要 Python 3 與 pandas / numpy' };
const H = { 'X-Strategy-Lab': '1' };
const servers = [];
after(() => { for (const s of servers) s.close(); });

async function boot(py = { dir: DIR }) {
  const server = await startServer(SITE, 0, { api: { py, fetchImpl: async () => { throw new Error('不該連 Yahoo'); }, pauseMs: 0, sleep: async () => {} } });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, headers = H) => { const r = await fetch(base + path, { headers }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const post = async (path, body, headers = { ...H, 'Content-Type': 'application/json' }) => { const r = await fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { base, get, post, server };
}
const wire = (bars) => ({ d: bars.d, o: Array.from(bars.o), h: Array.from(bars.h), l: Array.from(bars.l), c: Array.from(bars.c), v: Array.from(bars.v) });

test('health 與策略清單: 找得到 Python 與 pandas;列出資料夾裡的策略(底線開頭的不列)', opts, async () => {
  const { get } = await boot();
  const h = await get('/api/py/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.available, true); assert.match(h.body.python, /^3\./); assert.ok(h.body.pandas && h.body.numpy);
  assert.ok(h.body.dir.endsWith('py_strategies'));
  const l = await get('/api/py/strategies');
  assert.equal(l.status, 200);
  const ids = l.body.map((s) => s.id);
  assert.deepEqual(ids, ['boom', 'cheat_lookahead', 'noisy', 'sleepy', 'slow', 'sma_cross', 'trend_filter', 'trend_long_short']);
  const sma = l.body.find((s) => s.id === 'sma_cross');
  assert.equal(sma.name, '範例: SMA 交叉(事件模式)');
  assert.deepEqual(sma.params, [{ name: 'fast', value: 10 }, { name: 'slow', value: 30 }]);
  assert.deepEqual(l.body.find((s) => s.id === 'noisy').params, [{ name: 'level', value: 1 }, { name: 'label', value: 'abc' }]);
});

const bars = randomWalk(700, 5, 0.018, '2021-01-04');
const runPy = (post, id, extra = {}) => post('/api/py/run', { id, bars: wire(bars), ...extra });

/** 兩種做法(規則語法 / Python)在同一份資料上必須做出完全相同的交易 */
function sameTrades(a, b) {
  assert.ok(a.length > 5, `要有足夠多的交易才有比對意義(${a.length})`);
  assert.equal(a.length, b.length, '交易筆數');
  a.forEach((t, i) => {
    for (const k of ['dir', 'entryDate', 'exitDate', 'reason']) assert.equal(t[k], b[i][k], `第 ${i + 1} 筆 ${k}`);
    for (const k of ['entryPrice', 'exitPrice', 'shares', 'pnl']) assert.ok(Math.abs(t[k] - b[i][k]) <= 1e-9 * Math.max(1, Math.abs(t[k])), `第 ${i + 1} 筆 ${k}`);
  });
}

function rulesTrades(patch) {
  const c = compileStrategy({ ...emptyStrategy(), costs: { commissionBps: 5, slippageBps: 5 }, ...patch });
  assert.ok(c.ok, JSON.stringify(c.errors));
  return runPortfolio({ assets: [{ id: 'X', bars, weight: 1 }], compiled: c.compiled, capital: 100000 }).trades;
}

async function pythonTrades(post, id, params, patch = {}) {
  const r = await runPy(post, id, { params, check_lookahead: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const c = compileStrategy({ ...emptyStrategy(), source: 'python', python: { id, params, checkLookahead: false }, costs: { commissionBps: 5, slippageBps: 5 }, ...patch });
  assert.ok(c.ok, JSON.stringify(c.errors));
  const signals = signalsFromPython(r.body, bars, computeSignals(c.compiled, bars));
  return runPortfolio({ assets: [{ id: 'X', bars, weight: 1 }], compiled: c.compiled, capital: 100000, externalSignals: { X: signals } }).trades;
}

test('Python 策略(事件模式)與規則語法: 在同一份資料上交易逐筆相同(進出場日、價格、股數、損益)', opts, async () => {
  const { post } = await boot();
  const py = await pythonTrades(post, 'sma_cross', { fast: 8, slow: 25 });
  const rules = rulesTrades({ entry: { long: 'cross_above(sma(close, 8), sma(close, 25))', short: '' }, exit: { long: 'cross_below(sma(close, 8), sma(close, 25))', short: '' } });
  sameTrades(py, rules);
});

test('Python 策略(部位模式)與規則語法: 逐筆相同(+1 做多、0 空手)', opts, async () => {
  const { post } = await boot();
  const py = await pythonTrades(post, 'trend_filter', { n: 40 });
  const rules = rulesTrades({ entry: { long: 'close > sma(close, 40)', short: '' }, exit: { long: 'not (close > sma(close, 40))', short: '' } });
  sameTrades(py, rules);
});

test('Python 策略(部位 +1 / -1)在「允許做空」時多空都做,與規則語法逐筆相同;沒勾允許做空就只做多', opts, async () => {
  const { post } = await boot();
  const py = await pythonTrades(post, 'trend_long_short', { n: 40 }, { allowShort: true });
  const rules = rulesTrades({ allowShort: true, entry: { long: 'close > sma(close, 40)', short: 'close <= sma(close, 40)' }, exit: { long: 'not (close > sma(close, 40))', short: 'close > sma(close, 40)' } });
  sameTrades(py, rules);
  assert.ok(py.some((t) => t.dir === 'short') && py.some((t) => t.dir === 'long'));
  const longOnly = await pythonTrades(post, 'trend_long_short', { n: 40 }, { allowShort: false });
  assert.ok(longOnly.length > 3 && longOnly.every((t) => t.dir === 'long'), '沒勾允許做空: -1 的部位不會放空');
});

test('Python 策略也能搭配編輯器裡設定的止損止盈、倉位比例與成本(這些仍由網站處理)', opts, async () => {
  const { post } = await boot();
  const patch = { stopLoss: { mode: 'pct', pct: 3, atrN: 14, atrMult: 2, expr: '' }, takeProfit: { mode: 'pct', pct: 6, atrN: 14, atrMult: 4, expr: '' }, sizing: { pctEquity: 50 }, costs: { commissionBps: 10, slippageBps: 2 } };
  const py = await pythonTrades(post, 'sma_cross', { fast: 8, slow: 25 }, patch);
  const rules = rulesTrades({ entry: { long: 'cross_above(sma(close, 8), sma(close, 25))', short: '' }, exit: { long: 'cross_below(sma(close, 8), sma(close, 25))', short: '' }, ...patch });
  sameTrades(py, rules);
  assert.ok(py.some((t) => t.reason === 'stop_loss' || t.reason === 'take_profit'), '止損止盈真的有觸發');
});

test('偷看未來的策略被抓出來;誠實的策略通過檢查;可以關閉檢查', opts, async () => {
  const { post } = await boot();
  const honest = await runPy(post, 'sma_cross');
  assert.equal(honest.status, 200);
  assert.deepEqual([honest.body.lookahead.checked, honest.body.lookahead.ok], [true, true]);
  const cheat = await runPy(post, 'cheat_lookahead');
  assert.equal(cheat.status, 200, '策略照樣跑完(由網站顯示警告,不是拒絕執行)');
  assert.equal(cheat.body.lookahead.ok, false);
  assert.match(cheat.body.lookahead.date, /^20\d\d-\d\d-\d\d$/);
  const off = await runPy(post, 'cheat_lookahead', { check_lookahead: false });
  assert.equal(off.body.lookahead.checked, false);
});

test('策略的 print 輸出與參數: 收集輸出、參數覆蓋預設值、不認得的參數被拒絕', opts, async () => {
  const { post } = await boot();
  const r = await runPy(post, 'noisy', { params: { label: 'xyz' }, check_lookahead: false });
  assert.equal(r.status, 200); assert.match(r.body.log, /noisy says hi xyz/);
  const bad = await runPy(post, 'noisy', { params: { nope: 1 } });
  assert.equal(bad.status, 422); assert.match(bad.body.error, /參數「nope」不在這個策略的 PARAMS 裡/);
});

test('策略執行出錯: 回 422 與錯誤說明(不是伺服器當掉)', opts, async () => {
  const { post, get } = await boot();
  const r = await runPy(post, 'boom');
  assert.equal(r.status, 422);
  assert.match(r.body.error, /策略執行時出錯: KeyError/);
  assert.equal((await get('/api/py/health')).status, 200, '伺服器還活著');
});

test('逾時: 跑太久的策略被中止並回 504', opts, async () => {
  const { post } = await boot({ dir: DIR, timeoutMs: 1500 });
  const t0 = Date.now();
  const r = await runPy(post, 'slow', { check_lookahead: false });
  assert.equal(r.status, 504); assert.match(r.body.error, /超過 2 秒|超過 1 秒|已中止/);
  assert.ok(Date.now() - t0 < 10000);
});

test('請求檢查: 沒有標頭、不是 JSON、方法不對、壞的 id、格式不對的資料都被擋下', opts, async () => {
  const { post, get, base } = await boot();
  const okBody = { id: 'sma_cross', bars: wire(bars), check_lookahead: false };
  assert.equal((await post('/api/py/run', okBody, { 'Content-Type': 'application/json' })).status, 403, '沒有 X-Strategy-Lab 標頭');
  assert.equal((await post('/api/py/run', JSON.stringify(okBody), { ...H, 'Content-Type': 'text/plain' })).status, 415, '不是 application/json(別的網站不用預檢就能送出的格式)');
  assert.equal((await post('/api/py/run', '{not json')).status, 400);
  assert.equal((await get('/api/py/run')).status, 405);
  assert.equal((await fetch(`${base}/api/py/strategies`, { method: 'POST', headers: H })).status, 405);
  for (const id of ['../x', 'a/b', 'a.py', '', 'x'.repeat(61), '..%2Fx', 'a b']) assert.equal((await post('/api/py/run', { ...okBody, id })).status, 400, JSON.stringify(id));
  assert.equal((await post('/api/py/run', { ...okBody, id: 'no_such_strategy' })).status, 422);
  assert.equal((await post('/api/py/run', { id: 'sma_cross', bars: { d: ['2024-01-02'], o: [1], h: [1], l: [1], c: [1, 2] } })).status, 400);
  assert.equal((await post('/api/py/run', { id: 'sma_cross' })).status, 400);
  const status = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/py/health', headers: { ...H, Host: 'evil.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403, 'Host 不是本機');
});

test('底線開頭的檔案不是策略(不能被執行);策略 id 只能是資料夾裡的 .py 檔名', opts, async () => {
  const { post } = await boot();
  const r = await runPy(post, '_hidden', { check_lookahead: false });
  assert.equal(r.status, 200, '(底線開頭只是不列在清單裡;檔案仍在資料夾裡,算你自己放的)');
});

test('同時多個請求: 最多同時跑 2 個,其餘排隊,全部都成功', opts, async () => {
  const { post } = await boot();
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => runPy(post, 'sma_cross', { params: { fast: 5 + i, slow: 30 }, check_lookahead: false })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.notDeepEqual(rs[0].body.signals.entry_long, rs[5].body.signals.entry_long);
});

test('請求太大的資料(超過 20 萬根)在送進 Python 之前就被擋下', opts, async () => {
  const { post } = await boot();
  const big = { d: Array(200001).fill('2024-01-02'), o: Array(200001).fill(1), h: Array(200001).fill(1), l: Array(200001).fill(1), c: Array(200001).fill(1), v: [] };
  const r = await post('/api/py/run', { id: 'sma_cross', bars: big });
  assert.equal(r.status, 400); assert.match(r.body.error, /資料太長/);
});

test('同時最多跑 2 個子行程: 4 個很慢的請求要分成兩批', opts, async () => {
  const { post } = await boot({ dir: DIR, timeoutMs: 60000 });
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 4 }, () => post('/api/py/run', { id: 'sleepy', bars: wire(bars), check_lookahead: false })));
  assert.ok(rs.every((r) => r.status === 200), JSON.stringify(rs.map((r) => r.status)));
  assert.ok(Date.now() - t0 >= 3800, `4 個各睡 2 秒、同時最多 2 個 → 至少 4 秒(實際 ${Date.now() - t0} ms)`);
});

test('沒有 Python / 沒有 pandas / 沒有策略資料夾 / 沒有啟用: health 說明原因,執行回 503', async () => {
  const noPython = await boot({ dir: DIR, python: '/nonexistent/python-xyz' });
  const h = await noPython.get('/api/py/health');
  assert.equal(h.body.available, false); assert.match(h.body.reason, /找不到 Python/);
  const r = await noPython.post('/api/py/run', { id: 'sma_cross', bars: wire(bars) });
  assert.equal(r.status, 503); assert.match(r.body.error, /找不到 Python/);
  assert.equal((await noPython.get('/api/py/strategies')).status, 503);

  if (hasPython) {
    const noDir = await boot({ dir: '/nonexistent/strategies' });
    assert.match((await noDir.get('/api/py/health')).body.reason, /找不到策略資料夾/);
  }
  const off = await boot(null);
  const hh = await off.get('/api/py/health');
  assert.equal(hh.status, 200); assert.equal(hh.body.available, false); assert.match(hh.body.reason, /沒有啟用/);
  assert.equal((await off.get('/api/py/strategies')).status, 404);
});
