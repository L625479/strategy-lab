// 入口: 組裝編輯器、標的選擇、回測與結果。

import { toBars, cleanId, parseCsv, priceFileName } from './engine/data.js';
import { runPortfolio } from './engine/portfolio.js';
import { signalsFromPython, pythonWarnings } from './engine/pystrategy.js';
import { apiAvailable, downloadSeries, listPythonStrategies, pythonHealth, runPythonStrategy, searchSymbols } from './engine/remote.js';
import { compileStrategy, computeSignals, decodeShare, encodeShare, getTemplate } from './engine/strategy.js';
import { $, debounce, h } from './ui/dom.js';
import { createEditor } from './ui/editor.js';
import { renderEmpty, renderError, renderResults } from './ui/results.js';
import { deleteUserSeries, listUserSeries, loadSession, loadTheme, saveSession, saveTheme, saveUserSeries } from './ui/store.js';
import { createTargets } from './ui/targets.js';

const resultsMount = $('#results');
const priceCache = new Map();          // id -> bars(內建資料與使用者上傳的都放這裡)
let lastCtx = null, view = null, running = false;

// ---- 主題 ---------------------------------------------------------------------

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
}
applyTheme(loadTheme());
$('#theme').addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next); saveTheme(next);
  if (lastCtx) draw(lastCtx); // 圖表的顏色在建立時讀取,換主題要重畫
  weightsApp?.redraw();
});

// ---- 小提示 -------------------------------------------------------------------

let toastTimer;
function toast(message) {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = message; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---- 元件 ---------------------------------------------------------------------

const panel = $('#panel');
const editorMount = h('div'), targetsMount = h('div');
const runBtn = h('button', { type: 'button', class: 'primary', id: 'run' }, '執行回測');
panel.append(editorMount, targetsMount, h('div', { class: 'run-bar' }, runBtn));

const persist = debounce(() => saveSession({ strategy: editor.getStrategy(), targets: targets.get() }), 400);

async function shareLink() {
  const payload = { v: 1, strategy: editor.getStrategy(), targets: targets.get() };
  payload.targets.items = payload.targets.items.filter((i) => !userIds.has(i.id));   // 上傳的資料只存在你的瀏覽器,無法分享
  if (payload.targets.benchmark && userIds.has(payload.targets.benchmark)) payload.targets.benchmark = '';
  const url = `${location.origin}${location.pathname}#s=${encodeShare(payload)}`;
  try { await navigator.clipboard.writeText(url); toast('已複製分享連結(連結內含策略與標的設定)'); } catch { prompt('複製這個連結:', url); }
}

const apiMarked = Boolean(document.querySelector('meta[name="strategy-lab-api"]'));   // 網站是不是由 tools/serve.mjs 提供(有 /api)
const editor = createEditor(editorMount, {
  onChange: persist, onShare: shareLink,
  python: apiMarked ? { health: () => pythonHealth(), list: () => listPythonStrategies() } : null,
});
const userIds = new Set();

async function onUpload(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error('檔案超過 8 MB');
  const { bars, issues, staleShare } = parseCsv(await file.text());
  let id = cleanId(file.name.replace(/\.[^.]+$/, '')) || 'CSV';
  if (targets.asset(id) && !userIds.has(id)) id = `${id}-csv`;
  const notes = [`已載入 ${bars.n} 根(${bars.d[0]} ~ ${bars.d.at(-1)})`];
  if (issues.skipped) notes.push(`略過 ${issues.skipped} 列無效資料`);
  if (issues.repaired) notes.push(`修正 ${issues.repaired} 列高低價矛盾`);
  if (issues.adjusted) notes.push('已用 Adj Close 換算成調整後價格');
  const warn = staleShare > 0.1 ? `有 ${(staleShare * 100).toFixed(0)}% 的 K 棒開盤價 = 收盤價,收盤價疑似過期,回測結果可能失真` : '';
  priceCache.set(id, bars);
  userIds.add(id);
  const saved = await saveUserSeries(id, id, bars, { warn });
  if (!saved) notes.push('(瀏覽器封鎖了儲存空間,關掉頁面後需要重新上傳)');
  return { asset: { id, name: file.name, category: '我的資料', first: bars.d[0], last: bars.d.at(-1), n: bars.n, warn, removable: true }, message: notes.join(';') };
}

const SOURCE_LABEL = '已下載(Yahoo)';

/** 輸入代號 → 由本機伺服器從 Yahoo 抓日線(調整後價格)、清理、檢查品質;存在這個瀏覽器裡,下次開啟還在。 */
async function onDownload(symbol, { fresh = false } = {}) {
  const { bars, info } = await downloadSeries(symbol, { fresh });
  const id = info.symbol;
  if (targets.asset(id) && !userIds.has(id)) throw new Error(`內建資料已經有 ${id},直接從清單選就好`);
  priceCache.set(id, bars);
  userIds.add(id);
  const saved = await saveUserSeries(id, info.name, bars, { warn: info.warn, source: 'yahoo', updated: info.updated, currency: info.currency, exchange: info.exchange });
  const notes = [`已${fresh ? '更新' : '下載'} ${id}(${info.name}): ${bars.n.toLocaleString('en-US')} 根日線 ${bars.d[0]} ~ ${bars.d.at(-1)},調整後價格,來源 Yahoo Finance`];
  if (info.warn) notes.push(`⚠ ${info.warn}`);
  if (!saved) notes.push('(瀏覽器封鎖了儲存空間,關掉頁面後需要重新下載)');
  return { asset: { id, name: info.name, category: SOURCE_LABEL, first: bars.d[0], last: bars.d.at(-1), n: bars.n, warn: info.warn, removable: true, source: 'yahoo', updated: info.updated }, message: notes.join(';') };
}

const targets = createTargets(targetsMount, {
  onChange: persist,
  onUpload, onDownload, onSearch: (q) => searchSymbols(q),
  // 輸入代號 → 下載 → 馬上用目前的策略回測(重新下載時,只有這個標的正被選取才重跑)
  onDownloaded: ({ id, fresh }) => { if (!fresh || targets.get().items.some((i) => i.id === id)) run(); },
  onRemove: async (id) => { userIds.delete(id); priceCache.delete(id); await deleteUserSeries(id); targets.removeAsset(id); },
});

// ---- 資料 ---------------------------------------------------------------------

async function loadUniverse() {
  try {
    const res = await fetch('data/universe.json', { cache: 'no-cache' });
    if (!res.ok) return { assets: [], updated: null };
    const json = await res.json();
    return { updated: json.updated || null, source: json.source || '', assets: (json.assets || []).map((a) => ({ id: a.id, name: a.name || a.id, category: a.category || '其他', first: a.first, last: a.last, n: a.n, warn: a.warn || '' })) };
  } catch { return { assets: [], updated: null }; }
}

async function getBars(id) {
  if (priceCache.has(id)) return priceCache.get(id);
  const res = await fetch(`data/prices/${priceFileName(id)}.json`);
  if (!res.ok) throw new Error(`找不到 ${id} 的價格資料(HTTP ${res.status})`);
  const bars = toBars(await res.json());
  priceCache.set(id, bars);
  return bars;
}

// ---- 執行回測 -----------------------------------------------------------------

function draw(ctx) {
  view?.destroy();
  view = renderResults(resultsMount, ctx);
}

async function run() {
  if (running) return;
  const compiled = compileStrategy(editor.getStrategy());
  editor.showErrors(compiled.errors, compiled.warnings);
  if (!compiled.ok) {
    renderError(resultsMount, `策略有 ${compiled.errors.length} 個問題,請先在左邊修正(有紅字標示的欄位)。`);
    panel.scrollTo?.({ top: 0, behavior: 'smooth' });
    return;
  }
  const t = targets.get();
  if (!t.items.length) { renderError(resultsMount, '請先選擇至少一個標的。'); return; }
  if (!(t.capital > 0)) { renderError(resultsMount, '起始資金必須大於 0。'); return; }

  running = true; runBtn.disabled = true; runBtn.textContent = '計算中…';
  resultsMount.style.opacity = '0.5';
  try {
    const ids = [...new Set([...t.items.map((i) => i.id), ...(t.benchmark ? [t.benchmark] : [])])];
    const loaded = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await getBars(id)])));
    // Python 策略: 訊號在伺服器端(strategies_py/ 的 .py 檔)對每個標的算出來,成交與績效仍由這裡的回測引擎處理
    const pyWarnings = [];
    let externalSignals = null;
    const py = compiled.compiled.python;
    if (py) {
      externalSignals = {};
      await Promise.all(t.items.map(async (i) => {
        const bars = loaded[i.id];
        const resp = await runPythonStrategy({ id: py.id, params: py.params, bars, checkLookahead: py.checkLookahead });
        externalSignals[i.id] = signalsFromPython(resp, bars, computeSignals(compiled.compiled, bars));
        pyWarnings.push(...pythonWarnings(resp, i.id));
      }));
    }
    const result = runPortfolio({
      externalSignals,
      assets: t.items.map((i) => ({ id: i.id, name: targets.asset(i.id)?.name, bars: loaded[i.id], weight: i.weight })),
      compiled: compiled.compiled, capital: t.capital, start: t.start || null, end: t.end || null,
      benchmark: t.benchmark ? { id: t.benchmark, bars: loaded[t.benchmark] } : null,
    });
    lastCtx = {
      result, mode: t.mode, strategyName: compiled.compiled.strategy.name, warnings: [...compiled.warnings, ...pyWarnings],
      assetInfo: (id) => targets.asset(id) || { name: '', warn: '' }, colorSlot: targets.colorSlot,
    };
    draw(lastCtx);
  } catch (err) {
    renderError(resultsMount, compiled.compiled.python ? `Python 策略「${compiled.compiled.python.id}」: ${err.message || err}` : (err.message || String(err)));
  } finally {
    running = false; runBtn.disabled = false; runBtn.textContent = '執行回測'; resultsMount.style.opacity = '';
  }
}

runBtn.addEventListener('click', run);
// 離開或切到背景時立刻存檔(去抖動的存檔可能還沒執行)
addEventListener('pagehide', () => persist.flush());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist.flush(); });
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!TABS.bt[1].hidden) run(); else if (!TABS.w[1].hidden) weightsApp?.run(); else dayTrade?.run(); } });

// ---- 分頁: 策略回測 / 當沖掃描(當沖頁在第一次開啟時才載入) -------------------------------

let dayTrade = null, weightsApp = null;
const TABS = { bt: [$('#tab-bt'), $('#app-bt')], w: [$('#tab-w'), $('#app-w')], dt: [$('#tab-dt'), $('#app-dt')] };

async function showTab(name) {
  for (const [key, [btn, main]] of Object.entries(TABS)) { btn.setAttribute('aria-selected', String(key === name)); main.hidden = key !== name; }
  try { localStorage.setItem('lab.tab', name); } catch { /* 瀏覽器封鎖儲存空間時,下次還是從預設分頁開始 */ }
  if (name === 'w' && !weightsApp) {
    try {
      const { createWeights } = await import('./ui/weights.js');
      weightsApp = createWeights({ panelMount: $('#panel-w'), resultsMount: $('#results-w'), getAssets: () => targets.list(), getBars, toast });
    } catch (err) { $('#results-w').replaceChildren(h('div', { class: 'errors', role: 'alert' }, `目標權重分頁載入失敗: ${err.message}`)); }
  } else if (name === 'w') weightsApp?.refreshAssets();     // 在回測分頁上傳了新的 CSV 之後,這裡的選單要跟著更新
  if (name === 'dt' && !dayTrade) {
    try {
      const { createDayTrade } = await import('./ui/daytrade.js');
      dayTrade = createDayTrade({ panelMount: $('#panel-dt'), resultsMount: $('#results-dt'), getAssets: () => targets.list(), getBars, toast });
      dayTrade.refreshAssets();
    } catch (err) { $('#results-dt').replaceChildren(h('div', { class: 'errors', role: 'alert' }, `當沖掃描載入失敗: ${err.message}`)); }
  }
}
for (const [key, [btn]] of Object.entries(TABS)) btn.addEventListener('click', () => showTab(key));

// ---- 啟動 ---------------------------------------------------------------------

async function boot() {
  renderEmpty(resultsMount, false);
  apiAvailable({ marked: apiMarked }).then((ok) => targets.setNetwork(ok));        // 有沒有「輸入代號自動下載」(要用 node tools/serve.mjs 啟動)
  const [{ assets, updated, source }, saved] = await Promise.all([loadUniverse(), listUserSeries()]);
  const mine = saved.map((s) => {
    const bars = toBars(s);
    priceCache.set(s.id, bars);
    userIds.add(s.id);
    const yahoo = s.meta?.source === 'yahoo';
    return { id: s.id, name: s.name || s.id, category: yahoo ? SOURCE_LABEL : '我的資料', first: bars.d[0], last: bars.d.at(-1), n: bars.n, warn: s.meta?.warn || '', removable: true, ...(yahoo ? { source: 'yahoo', updated: s.meta?.updated || '' } : {}) };
  });
  targets.setAssets([...mine, ...assets]);
  if (updated) $('footer')?.append(h('p', null, `內建行情資料${source ? `來源: ${source},` : ''}更新於 ${updated}(調整後價格,日線),由部署流程在每次發布時重新抓取;網站上沒有任何手寫或模擬的行情。你上傳的資料則完全是你自己的檔案。`));

  // 還原順序: 分享連結 > 上次的工作 > 預設範本
  let from = null;
  const m = /^#s=(.*)$/.exec(location.hash);
  if (m) { try { from = decodeShare(m[1]); } catch { toast('分享連結無法解析,已改用預設設定'); } }
  from = from?.strategy ? from : loadSession();
  const pick = assets.find((a) => a.id === 'SPY') || assets[0] || mine[0];
  if (from?.strategy) {
    editor.setStrategy(from.strategy);
    targets.set(from.targets || {});
  } else {
    editor.setStrategy(getTemplate('ema_rsi').strategy);
    targets.set({ mode: 'single', items: pick ? [{ id: pick.id, weight: 1 }] : [] });
  }
  if (!targets.get().items.length && pick) targets.set({ ...targets.get(), items: [{ id: pick.id, weight: 1 }] });
  renderEmpty(resultsMount, targets.hasAssets());
  if (targets.get().items.length) run();
  let tab = 'bt';
  try { const t = localStorage.getItem('lab.tab'); tab = t === 'dt' || t === 'w' ? t : 'bt'; } catch { /* 同上 */ }
  if (tab !== 'bt') showTab(tab);
}

boot();
