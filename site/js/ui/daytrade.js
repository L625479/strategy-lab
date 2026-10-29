// 「當沖掃描」分頁: 設定資料、規則(單一規則或規則網格)、成交與驗收標準,執行掃描並顯示結果。
// 掃描在 Web Worker 裡跑;holdout 預設不會被算進去,要看必須明確按下按鈕。

import {
  DEFAULTS, compileGrid, emptyDayRule, emptyGrid, normalizeDayRule, normalizeGrid, ruleToGrid, standardGrid,
} from '../engine/daytrade.js';
import { parseCsv, cleanId } from '../engine/data.js';
import { BUILTIN_SERIES, makeFunctions } from '../engine/indicators.js';
import { candidatesCard, detailCard, frontierCard, rulesCard, scatterCard, summaryCard } from './dtResults.js';
import { createRunner } from './dtRunner.js';
import { $$, clear, download, h, pct, safeFilename } from './dom.js';

const STORE = 'lab.dt.v1', PEEKS = 'lab.dt.peeks.v1';
const clone = (x) => JSON.parse(JSON.stringify(x));
const read = (key) => { try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

const hash = (text) => { let x = 2166136261; for (let i = 0; i < text.length; i++) { x ^= text.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36); };

// ---- 單一規則的範本 ------------------------------------------------------------------

const ATRP = { name: 'atrp', expr: 'sma(tr(), 14) / close' };
const RULE_TEMPLATES = [
  { id: 'gap_dn', name: '跳空下跌 1 ATR → 開盤買進、停利 1%', rule: { side: 'long', setup: 'open / close - 1 <= -atrp', entry: { limit: '' }, exit: { takeProfit: '0.01' } } },
  { id: 'rsi2', name: 'RSI(2) 超賣 → 開盤買進、收盤出場', rule: { side: 'long', setup: 'rsi(close, 2) < 10', entry: { limit: '' }, exit: { takeProfit: '' } } },
  { id: 'gap_up', name: '跳空上漲 1 ATR → 開盤放空、收盤回補', rule: { side: 'short', setup: 'open / close - 1 >= atrp', entry: { limit: '' }, exit: { takeProfit: '' } } },
  { id: 'limit', name: '開盤下方 1 ATR 限價買進、停利 1 ATR', rule: { side: 'long', setup: 'true', entry: { limit: 'atrp' }, exit: { takeProfit: 'atrp' } } },
  { id: 'trend_dip', name: '站上 200 日線且連跌 3 日 → 開盤買進、收盤出場', rule: { side: 'long', setup: 'close > sma(close, 200) and close < close[1] and close[1] < close[2]', entry: { limit: '' }, exit: { takeProfit: '' } } },
  { id: 'baseline', name: '基準: 每天開盤買進、收盤賣出', rule: { side: 'long', setup: 'true', entry: { limit: '' }, exit: { takeProfit: '' } } },
];
const fromTemplate = (id) => {
  const t = RULE_TEMPLATES.find((x) => x.id === id) || RULE_TEMPLATES[0];
  return normalizeDayRule({ ...emptyDayRule(), name: t.name, indicators: [ATRP], ...t.rule });
};

const SMALL_GRID = normalizeGrid({
  name: '小型範例網格(跳空類 × 3 × 3)',
  indicators: [ATRP],
  setups: [{ side: 'long', name: 'gap<=-1atr', expr: 'open / close - 1 <= -atrp' }, { side: 'long', name: 'gap<=-2atr', expr: 'open / close - 1 <= -2 * atrp' }, { side: 'short', name: 'gap>=+1atr', expr: 'open / close - 1 >= atrp' }],
  entries: [{ name: 'open', expr: '' }, { name: 'lim0.5atr', expr: '0.5 * atrp' }, { name: 'lim1atr', expr: 'atrp' }],
  exits: [{ name: 'close', expr: '' }, { name: 'tp1atr', expr: 'atrp' }, { name: 'tp1%', expr: '0.01' }],
});

const DEFAULT_SETTINGS = { costBps: 5, bufferBps: 10, winPct: 80, meanPct: 1, sharePct: 50, devMin: 30, holdMin: 8, optimistic: true, splitDate: '' };
const AUX_TICKERS = new Set(['^VIX']);

// ---- 主程式 --------------------------------------------------------------------------

export function createDayTrade({ panelMount, resultsMount, getAssets, getBars, toast }) {
  const runner = createRunner();
  const saved = read(STORE) || {};
  const st = {
    source: ['builtin', 'npz', 'csv'].includes(saved.source) ? saved.source : 'builtin',
    picked: new Set(Array.isArray(saved.picked) ? saved.picked.filter((x) => typeof x === 'string') : []),
    mode: saved.mode === 'grid' ? 'grid' : 'single',
    rule: saved.rule ? normalizeDayRule(saved.rule) : fromTemplate('gap_dn'),
    gridText: typeof saved.gridText === 'string' ? saved.gridText : JSON.stringify(standardGrid(), null, 1),
    settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
    info: null, loading: '', running: false,
  };
  let run = null;                                              // 最近一次掃描: { cfg, scan, selected, detail, holdouts, view }
  let dataMount, ruleMount, settingsMount, runBtn;

  const persist = () => write(STORE, { source: st.source, picked: [...st.picked], mode: st.mode, rule: st.rule, gridText: st.gridText, settings: st.settings });

  // ---- 共用元件 ----

  const labelled = (text, node) => h('label', { class: 'field' }, text, node);
  const field = (path, input) => { input.dataset.field = path; return h('div', { class: 'stack' }, input, h('div', { class: 'err-slot', dataset: { for: path } })); };
  const textInput = (path, value, onInput, { expr = false, placeholder = '' } = {}) => field(path, h('input', { type: 'text', value, class: expr ? 'expr' : '', placeholder, spellcheck: false, autocomplete: 'off', 'aria-label': path, onInput: (e) => { onInput(e.target.value); persist(); } }));
  const numInput = (path, value, onInput, attrs = {}) => field(path, h('input', { type: 'number', value: Number.isFinite(value) ? value : 0, step: 'any', ...attrs, 'aria-label': path, onInput: (e) => { onInput(e.target.value === '' ? 0 : Number(e.target.value)); persist(); } }));
  const section = (title, ...body) => h('details', { class: 'card', open: true }, h('summary', null, title), h('div', { class: 'body' }, ...body));

  // ---- 資料 ----

  const assetsForPicker = () => getAssets().filter((a) => !AUX_TICKERS.has(a.id) && !a.id.startsWith('^'));

  async function loadInfo(promise, label) {
    st.loading = label; renderData();
    try {
      st.info = await promise;
      st.info.label = label;
      if (!st.settings.splitDate || st.settings.splitDate <= st.info.first || st.settings.splitDate > st.info.last) st.settings.splitDate = defaultSplit(st.info);
      run = null; renderResults(); renderSettings();
      toast(`已載入 ${st.info.tickers} 檔 · ${st.info.first} ~ ${st.info.last}`);
    } catch (err) { st.info = null; toast(`載入失敗: ${err.message}`); st.loadError = err.message; }
    st.loading = ''; renderData(); persist();
  }

  const defaultSplit = (info) => {
    if (info.first < '2021-06-01' && info.last > '2021-06-01') return '2021-06-01';
    const a = Date.parse(info.first), b = Date.parse(info.last);
    return new Date(a + (b - a) * 0.8).toISOString().slice(0, 10);
  };

  async function loadBuiltin() {
    const ids = [...st.picked].filter((id) => assetsForPicker().some((a) => a.id === id));
    if (!ids.length) { toast('請先勾選至少一檔標的'); return; }
    st.loadError = '';
    await loadInfo((async () => {
      const entries = [];
      for (const id of ids) entries.push({ id, bars: await getBars(id) });
      return runner.call('loadBars', { entries, aux: {} });
    })(), `內建/我的資料 ${ids.length} 檔`);
  }

  async function loadNpzFile(file) {
    if (file.size > 400 * 1024 * 1024) { toast('檔案超過 400 MB'); return; }
    st.loadError = '';
    await loadInfo((async () => runner.call('loadNpz', { buffer: await file.arrayBuffer() }))(), file.name);
  }

  async function loadCsvFiles(files) {
    st.loadError = '';
    const entries = [], notes = [], used = new Set();
    for (const f of files) {
      try {
        if (f.size > 8 * 1024 * 1024) throw new Error('檔案超過 8 MB');
        const { bars } = parseCsv(await f.text());
        let id = cleanId(f.name.replace(/\.[^.]+$/, '')) || 'CSV';
        while (used.has(id)) id += '_';
        used.add(id); entries.push({ id, bars });
      } catch (err) { notes.push(`${f.name}: ${err.message}`); }
    }
    if (notes.length) st.loadError = `${notes.length} 個檔案無法讀取 — ${notes.slice(0, 3).join(';')}`;
    if (!entries.length) { renderData(); return; }
    await loadInfo(runner.call('loadBars', { entries, aux: {} }), `CSV ${entries.length} 檔`);
  }

  function renderData() {
    clear(dataMount);
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '資料來源' },
      ...[['builtin', '內建標的'], ['npz', '上傳 .npz 面板'], ['csv', '上傳多個 CSV']].map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(st.source === v), onClick: () => { st.source = v; persist(); renderData(); } }, t)));
    const body = [seg];
    if (st.source === 'builtin') {
      const assets = assetsForPicker();
      if (!assets.length) body.push(h('p', { class: 'hint' }, '這個網站目前沒有內建價格資料。請改用上傳。'));
      else {
        const groups = [...new Set(assets.map((a) => a.category))];
        const picker = h('div', { class: 'picker', style: { maxHeight: '220px' } }, groups.flatMap((g) => [
          h('div', { class: 'group' }, g),
          ...assets.filter((a) => a.category === g).map((a) => h('label', { class: 'pick-row', style: { padding: '2px 10px', gap: '8px', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: st.picked.has(a.id), 'aria-label': a.id, onChange: (e) => { if (e.target.checked) st.picked.add(a.id); else st.picked.delete(a.id); persist(); count.textContent = `已選 ${st.picked.size} 檔`; } }),
            h('span', { class: 'sym' }, a.id), h('span', { class: 'nm' }, a.name), a.warn ? h('span', { class: 'warn-tag', title: a.warn }, '資料警告') : null)),
        ]));
        const count = h('span', { class: 'hint' }, `已選 ${st.picked.size} 檔`);
        body.push(picker, h('div', { class: 'row wrap' },
          h('button', { type: 'button', class: 'ghost', onClick: () => { assets.forEach((a) => st.picked.add(a.id)); persist(); renderData(); } }, '全選'),
          h('button', { type: 'button', class: 'ghost', onClick: () => { st.picked.clear(); persist(); renderData(); } }, '清除'),
          count, h('span', { class: 'grow' }), h('button', { type: 'button', disabled: Boolean(st.loading), onClick: loadBuiltin }, '載入選取的標的')));
        body.push(h('p', { class: 'hint' }, '當沖統計靠樣本數: 標的越多越有意義。內建清單只有幾十檔;要跑完整的 S&P 500 請上傳面板檔。'));
      }
    } else if (st.source === 'npz') {
      body.push(h('label', { class: 'field' }, '選擇 .npz 檔(例如研究程式產生的 cache/sp500_daily.npz)',
        h('input', { type: 'file', accept: '.npz', 'aria-label': '上傳 npz 面板', onChange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadNpzFile(f); } })),
      h('p', { class: 'hint' }, '需要的陣列: dates(日)、tickers(檔)、Open / High / Low / Close(日 × 檔,float32),選用 vix(日)。檔案只在你的瀏覽器裡讀取,不會上傳。'));
    } else {
      body.push(h('label', { class: 'field' }, '選擇多個 CSV(每個檔案一檔標的,代號取自檔名)',
        h('input', { type: 'file', accept: '.csv,text/csv', multiple: true, 'aria-label': '上傳多個 CSV', onChange: (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) loadCsvFiles(fs); } })),
      h('p', { class: 'hint' }, '欄位需要 time(或 date)、open、high、low、close;不同標的的日期不需要一樣,缺的日子視為沒有資料。'));
    }
    if (st.loading) body.push(h('p', { class: 'status', role: 'status' }, `載入中: ${st.loading}…`));
    else if (st.loadError) body.push(h('div', { class: 'errors', role: 'alert' }, st.loadError));
    if (st.info && !st.loading) {
      const dropped = Object.entries(st.info.dropped || {});
      if (dropped.length) body.push(h('div', { class: 'notice' }, `${dropped.map(([id, n]) => `${id}(${n} 根)`).join('、')} 的 K 棒不在共同交易日曆上(例如週末),已略過。`));
      body.push(h('div', { class: 'status', 'data-testid': 'dt-info' }, h('strong', null, `${st.info.tickers} 檔 · ${st.info.days.toLocaleString('en-US')} 個交易日`), ` · ${st.info.first} ~ ${st.info.last} · 外部序列: ${st.info.aux.length ? st.info.aux.join('、') : '無'}`));
    }
    dataMount.append(h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, ...body));
  }

  // ---- 規則 ----

  const ERROR_MAP = [[/^setups\[0\]\.expr$/, 'setup'], [/^entries\[0\]\.expr$/, 'entry.limit'], [/^exits\[0\]\.expr$/, 'exit.takeProfit']];
  const mapField = (f) => (ERROR_MAP.find(([re]) => re.test(f)) || [null, f])[1];

  function listBlock(key, makeRow, add) {
    return [...st.rule[key].map((item, i) => makeRow(item, i)), h('div', null, h('button', { type: 'button', class: 'ghost', onClick: () => { add(); persist(); renderRule(); } }, `＋ 新增${{ params: '參數', indicators: '指標', aux: '外部序列' }[key]}`))];
  }

  function syntaxHelp() {
    const funcs = makeFunctions({ c: new Float64Array(0) });
    return h('details', { class: 'syntax' },
      h('summary', null, '語法說明: 「今天開盤時」能看到什麼'),
      h('p', { class: 'hint' }, '規則在今天開盤時判斷,所以只能用前一日(含)以前的資料加上今天的開盤價: open 是今天的開盤價;close / high / low / volume / hl2 / hlc3 和所有指標都是前一日的值,close[1] 是前二日。這是框架本身的設計,寫不出偷看當天高低收的規則。'),
      h('table', null,
        h('tr', null, h('td', null, '價格'), h('td', null, ...Object.entries(BUILTIN_SERIES).flatMap(([k, v]) => [h('code', { title: v }, k), ' ']))),
        h('tr', null, h('td', null, '跳空幅度'), h('td', null, h('code', null, 'open / close - 1'))),
        h('tr', null, h('td', null, 'ATR%'), h('td', null, h('code', null, 'sma(tr(), 14) / close'), ' 先在「指標」裡定義成 atrp')),
        h('tr', null, h('td', null, '條件'), h('td', null, '結果為真才交易。可以用 and / or / not、比較運算與下面的函式。')),
        h('tr', null, h('td', null, '限價距離'), h('td', null, '運算式,結果是占開盤價的比例(例如 atrp 或 0.01);做多掛在開盤價下方、放空掛在上方。')),
        h('tr', null, h('td', null, '停利幅度'), h('td', null, '運算式,結果是占進場價的比例(例如 0.01 = 1%)。')),
        ...Object.entries(funcs).map(([name, d]) => h('tr', null, h('td', null, h('code', null, name)), h('td', null, d.doc.replace(/^[^ ]+ /, '')))),
      ));
  }

  function renderRule() {
    clear(ruleMount);
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '規則模式' },
      ...[['single', '單一規則'], ['grid', '規則網格']].map(([v, t]) => h('button', { type: 'button', 'aria-pressed': String(st.mode === v), onClick: () => { st.mode = v; persist(); renderRule(); renderRunLabel(); } }, t)));
    const body = [seg];
    if (st.mode === 'single') {
      const r = st.rule;
      body.push(
        labelled('範本', h('select', { 'aria-label': '範本', onChange: (e) => { if (e.target.value) { st.rule = fromTemplate(e.target.value); persist(); renderRule(); } } },
          h('option', { value: '' }, '從範本開始…'), ...RULE_TEMPLATES.map((t) => h('option', { value: t.id }, t.name)))),
        h('div', { class: 'row wrap' },
          h('div', { class: 'grow' }, labelled('規則名稱', textInput('name', r.name, (v) => { r.name = v; }))),
          h('div', { style: { width: '110px' } }, labelled('方向', h('select', { 'aria-label': '方向', onChange: (e) => { r.side = e.target.value; persist(); } }, h('option', { value: 'long', selected: r.side === 'long' }, '做多'), h('option', { value: 'short', selected: r.side === 'short' }, '放空'))))),
        h('div', { class: 'sect-title' }, '條件(今天開盤時判斷,為真才交易)'),
        textInput('setup', r.setup, (v) => { r.setup = v; }, { expr: true, placeholder: '例如 open / close - 1 <= -atrp' }),
        h('div', { class: 'sect-title' }, '進場'),
        h('div', { class: 'row wrap' },
          h('select', { 'aria-label': '進場方式', onChange: (e) => { r.entry.limit = e.target.value === 'open' ? '' : (r.entry.limit || 'atrp'); persist(); renderRule(); } },
            h('option', { value: 'open', selected: !r.entry.limit.trim() }, '開盤市價'), h('option', { value: 'limit', selected: Boolean(r.entry.limit.trim()) }, '限價(開盤價往不利方向退)')),
          r.entry.limit.trim() ? h('div', { class: 'grow' }, textInput('entry.limit', r.entry.limit, (v) => { r.entry.limit = v; }, { expr: true, placeholder: '距離(占開盤價的比例),例如 atrp' })) : null),
        h('div', { class: 'sect-title' }, '出場'),
        h('div', { class: 'row wrap' },
          h('select', { 'aria-label': '出場方式', onChange: (e) => { r.exit.takeProfit = e.target.value === 'close' ? '' : (r.exit.takeProfit || '0.01'); persist(); renderRule(); } },
            h('option', { value: 'close', selected: !r.exit.takeProfit.trim() }, '收盤市價'), h('option', { value: 'tp', selected: Boolean(r.exit.takeProfit.trim()) }, '停利限價(沒到就收盤出場)')),
          r.exit.takeProfit.trim() ? h('div', { class: 'grow' }, textInput('exit.takeProfit', r.exit.takeProfit, (v) => { r.exit.takeProfit = v; }, { expr: true, placeholder: '幅度(占進場價的比例),例如 0.01' })) : null),
        h('div', { class: 'sect-title' }, '參數'),
        ...listBlock('params', (p, i) => h('div', { class: 'list-row param' }, textInput(`params[${i}].name`, p.name, (v) => { p.name = v; }, { placeholder: '名稱' }), numInput(`params[${i}].value`, p.value, (v) => { p.value = v; }),
          h('button', { class: 'icon ghost', type: 'button', 'aria-label': `刪除參數 ${p.name}`, onClick: () => { r.params.splice(i, 1); persist(); renderRule(); } }, '×')), () => r.params.push({ name: `p${r.params.length + 1}`, value: 1 })),
        h('div', { class: 'sect-title' }, '指標(由上往下計算;所有指標都有值的日子才交易)'),
        ...listBlock('indicators', (p, i) => h('div', { class: 'list-row' }, textInput(`indicators[${i}].name`, p.name, (v) => { p.name = v; }, { placeholder: '名稱' }), textInput(`indicators[${i}].expr`, p.expr, (v) => { p.expr = v; }, { expr: true, placeholder: '例如 sma(tr(), 14) / close' }),
          h('button', { class: 'icon ghost', type: 'button', 'aria-label': `刪除指標 ${p.name}`, onClick: () => { r.indicators.splice(i, 1); persist(); renderRule(); } }, '×')), () => r.indicators.push({ name: `ind${r.indicators.length + 1}`, expr: 'sma(close, 20)' })),
        h('div', { class: 'sect-title' }, '外部序列(例如 ^VIX;用前一日的收盤價)'),
        ...listBlock('aux', (p, i) => h('div', { class: 'list-row' }, textInput(`aux[${i}].name`, p.name, (v) => { p.name = v; }, { placeholder: '名稱' }), textInput(`aux[${i}].ticker`, p.ticker, (v) => { p.ticker = v; }, { expr: true, placeholder: '代號,例如 ^VIX' }),
          h('button', { class: 'icon ghost', type: 'button', 'aria-label': `刪除外部序列 ${p.name}`, onClick: () => { r.aux.splice(i, 1); persist(); renderRule(); } }, '×')), () => r.aux.push({ name: 'vix', ticker: '^VIX' })),
        h('div', { class: 'errors', id: 'dt-rule-errors', hidden: true, role: 'alert' }),
      );
    } else {
      const status = h('div', { id: 'dt-grid-status', class: 'hint', role: 'status' });
      const area = h('textarea', { class: 'code', rows: 16, spellcheck: false, 'aria-label': '規則網格 JSON', style: { height: 'auto', fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.45', resize: 'vertical' } });
      area.value = st.gridText;
      const check = () => {
        let g;
        try { g = JSON.parse(area.value); } catch (e) { status.className = 'field-error'; status.textContent = `不是有效的 JSON: ${e.message}`; return; }
        const c = compileGrid(g);
        if (c.ok) { status.className = 'hint'; status.textContent = `條件 ${c.compiled.setups.length} × 進場 ${c.compiled.entries.length} × 出場 ${c.compiled.exits.length} = ${c.compiled.setups.length * c.compiled.entries.length * c.compiled.exits.length} 條規則`; }
        else { status.className = 'errors'; status.replaceChildren(h('strong', null, `有 ${c.errors.length} 個問題:`), h('ul', null, ...c.errors.slice(0, 6).map((e) => h('li', null, `${e.field}: ${e.message}`)))); }
      };
      area.addEventListener('input', () => { st.gridText = area.value; persist(); check(); });
      const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const g = normalizeGrid(JSON.parse(await f.text())); st.gridText = JSON.stringify(g, null, 1); applyGridSettings(g); persist(); renderRule(); renderSettings(); } catch { toast('匯入失敗: 不是有效的網格 JSON'); } } });
      body.push(
        h('p', { class: 'hint' }, '網格 = 條件(附方向)× 進場 × 出場 的所有組合,逐組合計算勝率與平均報酬。直接改下面的 JSON,或載入範例。'),
        h('div', { class: 'row wrap' },
          h('button', { type: 'button', onClick: () => { st.gridText = JSON.stringify(standardGrid(), null, 1); applyGridSettings(standardGrid()); persist(); renderRule(); renderSettings(); } }, '載入標準網格(588 條)'),
          h('button', { type: 'button', class: 'ghost', onClick: () => { st.gridText = JSON.stringify(SMALL_GRID, null, 1); persist(); renderRule(); } }, '小型範例(27 條)'),
          h('button', { type: 'button', class: 'ghost', onClick: () => download(`${safeFilename(JSON.parse(area.value || '{}').name, 'grid')}.grid.json`, area.value, 'application/json') }, '匯出 JSON'),
          h('button', { type: 'button', class: 'ghost', onClick: () => file.click() }, '匯入 JSON'), file),
        area, status);
      queueMicrotask(check);
    }
    body.push(syntaxHelp());
    ruleMount.append(h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, ...body));
  }

  const applyGridSettings = (g) => { st.settings.costBps = g.costBps; st.settings.bufferBps = g.bufferBps; };

  // ---- 成交與驗收 ----

  function renderSettings() {
    clear(settingsMount);
    const s = st.settings;
    const n = (path, label, key, attrs = {}) => h('div', { class: 'grow' }, labelled(label, numInput(path, s[key], (v) => { s[key] = v; }, attrs)));
    settingsMount.append(h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
      h('div', { class: 'row wrap' }, n('costBps', '單邊成本 bps', 'costBps', { min: 0 }), n('bufferBps', '限價須穿價 bps', 'bufferBps', { min: 0 })),
      h('p', { class: 'hint' }, '來回成本 = 2 × 單邊。限價單與停利單必須被穿價這麼多才算成交,只碰到不算。'),
      h('div', { class: 'sect-title' }, '驗收標準(先寫定,事後不調整)'),
      h('div', { class: 'row wrap' }, n('winPct', 'D1 勝率 >(%)', 'winPct', { min: 0, max: 100 }), n('meanPct', 'D2 平均報酬 ≥(%)', 'meanPct', { step: 0.1 }), n('sharePct', 'D3 個股達標比例 >(%)', 'sharePct', { min: 0, max: 100 })),
      h('div', { class: 'row wrap' }, n('devMin', '個股最少筆數(開發集)', 'devMin', { min: 1 }), n('holdMin', '個股最少筆數(holdout)', 'holdMin', { min: 1 })),
      h('div', { class: 'sect-title' }, '資料切分'),
      labelled('Holdout 起始日(這天以前 = 開發集;掃描只用開發集)', field('splitDate', h('input', { type: 'date', value: s.splitDate, 'aria-label': 'holdout 起始日', onChange: (e) => { s.splitDate = e.target.value; persist(); } }))),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.optimistic, onChange: (e) => { s.optimistic = e.target.checked; persist(); } }), '同時算「樂觀上界」(限價 + 停利的規則;多花約一倍時間)'),
      h('p', { class: 'hint' }, '日線分不出盤中高低點的先後。保守算法 = 收盤已越過停利價才算停利(真實績效的下界,正式數字);樂觀算法 = 最高價碰到就算(上界)。連上界都過不了的規則可以直接淘汰。')));
  }

  // ---- 執行 ----

  function renderRunLabel() { if (runBtn) runBtn.textContent = st.running ? '計算中…' : (st.mode === 'single' ? '執行規則' : '執行網格掃描'); }

  const thresholds = () => ({ winThreshold: st.settings.winPct / 100, meanThreshold: st.settings.meanPct / 100, passShare: st.settings.sharePct / 100, eligShare: DEFAULTS.eligShare });

  function effectiveGrid() {
    let g;
    if (st.mode === 'single') g = ruleToGrid(st.rule);
    else { try { g = normalizeGrid(JSON.parse(st.gridText)); } catch (e) { return { error: `網格不是有效的 JSON: ${e.message}` }; } }
    return { grid: { ...g, costBps: st.settings.costBps, bufferBps: st.settings.bufferBps } };
  }

  function showRuleErrors(errors) {
    $$('.invalid', ruleMount).forEach((el) => el.classList.remove('invalid'));
    $$('.err-slot', ruleMount).forEach((el) => { el.textContent = ''; el.className = 'err-slot'; });
    const box = ruleMount.querySelector('#dt-rule-errors');
    if (st.mode !== 'single') return;
    for (const { field: f0, message } of errors) {
      const f = mapField(f0);
      const input = ruleMount.querySelector(`[data-field="${CSS.escape(f)}"]`);
      if (input) input.classList.add('invalid');
      const slot = ruleMount.querySelector(`.err-slot[data-for="${CSS.escape(f)}"]`);
      if (slot && !slot.textContent) { slot.textContent = message; slot.className = 'err-slot field-error'; }
    }
    if (box) { box.hidden = !errors.length; clear(box); if (errors.length) box.append(h('strong', null, `有 ${errors.length} 個問題需要修正(紅字欄位)`)); }
  }

  async function ensureAux(compiled) {
    const have = new Set(st.info.aux), missing = [];
    for (const a of compiled.aux) {
      if (have.has(a.ticker)) continue;
      const asset = getAssets().find((x) => x.id === a.ticker);
      if (!asset) { missing.push(a.ticker); continue; }
      try { st.info = { ...(await runner.call('setAux', { aux: { [a.ticker]: await getBars(a.ticker) } })), label: st.info.label }; have.add(a.ticker); renderData(); } catch { missing.push(a.ticker); }
    }
    return missing;
  }

  async function execute() {
    if (st.running) return;
    if (!st.info) { renderMessage('error', '請先在左邊載入資料(內建標的、.npz 面板或 CSV)。'); return; }
    const eg = effectiveGrid();
    if (eg.error) { renderMessage('error', eg.error); return; }
    const compiled = compileGrid(eg.grid);
    showRuleErrors(compiled.errors);
    if (!compiled.ok) { renderMessage('error', `規則有 ${compiled.errors.length} 個問題,請先修正。第一個: ${compiled.errors[0].field} — ${compiled.errors[0].message}`); return; }
    const s = st.settings;
    if (!s.splitDate) { renderMessage('error', '請設定 holdout 起始日。'); return; }
    st.running = true; runBtn.disabled = true; renderRunLabel();
    const progress = h('progress', { max: 1, value: 0, style: { width: '100%' } });
    const label = h('p', { class: 'status', role: 'status' }, '準備中…');
    clear(resultsMount); resultsMount.append(h('section', { class: 'card' }, h('h2', { style: { fontSize: '15px', marginBottom: '8px' } }, st.mode === 'single' ? '計算中' : '掃描中'), label, progress));
    try {
      const missing = await ensureAux(compiled.compiled);
      const cfg = { grid: eg.grid, splitDate: s.splitDate, devMinTrades: s.devMin, holdoutMinTrades: s.holdMin, optimistic: s.optimistic, thresholds: thresholds() };
      const t0 = performance.now();
      const scan = await runner.call('scan', cfg, { onProgress: (d, t) => { progress.value = d / t; label.textContent = `處理標的 ${d} / ${t}(${((performance.now() - t0) / 1000).toFixed(0)} 秒)`; } });
      run = { cfg, scan, selected: null, detail: null, holdouts: {}, missing, seconds: (performance.now() - t0) / 1000, view: { minPlotN: 30, showOpt: Boolean(s.optimistic), filter: '', side: 'all', onlyElig: true, sortBy: 'mean', sortDir: 'desc', limit: 150 } };
      st.lastError = '';
      renderResults();
      if (scan.rules.length === 1 || st.mode === 'single') select(scan.rules[0].key, { scroll: false });
    } catch (err) { renderMessage('error', err.message || String(err)); } finally {
      st.running = false; runBtn.disabled = false; renderRunLabel();
    }
  }

  // ---- 結果 ----

  function renderMessage(kind, text) {
    clear(resultsMount);
    resultsMount.append(kind === 'error' ? h('div', { class: 'errors', role: 'alert' }, text) : h('div', { class: 'empty' }, text));
  }

  function renderEmpty() {
    clear(resultsMount);
    resultsMount.append(h('div', { class: 'empty' },
      h('h2', null, '當沖規則掃描'),
      h('p', null, '每個「標的 × 交易日」是一筆獨立的當日進出交易。這裡看的是逐筆統計: 勝率、平均每筆淨報酬,以及多少比例的個股各自都達標。'),
      h('ol', null, h('li', null, '載入資料: 內建標的、你的 .npz 面板(例如 sp500_daily.npz)或多個 CSV'), h('li', null, '寫一條規則,或載入 588 條標準網格'), h('li', null, '設定驗收標準與 holdout 起始日,按「執行」')),
      h('p', { class: 'hint', style: { marginTop: '14px' } }, '掃描只用開發集;holdout 要自己明確按下按鈕才會揭曉,並且會記錄看過幾次。')));
  }

  const studyKey = () => `${hash(`${st.info.tickers}|${st.info.first}|${st.info.last}|${st.info.days}`)}|${hash(JSON.stringify(run.cfg.grid))}|${run.cfg.splitDate}`;
  const peeks = () => (read(PEEKS) || {})[studyKey()] || { total: 0, byKey: {} };
  function addPeek(key) {
    const all = read(PEEKS) || {}, k = studyKey(), p = all[k] || { total: 0, byKey: {} };
    p.total++; p.byKey[key] = (p.byKey[key] || 0) + 1; all[k] = p;
    write(PEEKS, all);
    return p;
  }
  const peeksText = (key) => { const p = peeks(); return p.total ? `這份資料與規則組合的 holdout 已經被查看 ${p.total} 次(這條規則 ${p.byKey[key] || 0} 次)。每多看一次,它的證據力就再打折。` : 'Holdout 還沒有被查看過。它是留給「最後驗證」用的:看過之後再依結果調整規則,就不再是沒看過的資料。'; };

  async function select(key, { scroll = true } = {}) {
    if (!run) return;
    run.selected = key; run.detail = null; renderDetail();
    if (scroll) detailRegion?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const mine = run;
    try {
      const d = await runner.call('detail', { ...mine.cfg, key, variant: 'cons', segment: 'dev' });
      if (mine !== run || mine.selected !== key) return;
      run.detail = d; renderDetail();
    } catch (err) { toast(`明細計算失敗: ${err.message}`); }
  }

  async function revealHoldout(key) {
    const p = peeks();
    const msg = p.total
      ? `這份資料與規則組合的 holdout 已經看過 ${p.total} 次。\n每多看一次,證據力就再打折。仍要看嗎?`
      : 'Holdout 是留給最後驗證的資料。\n看了之後,如果再依結果調整規則,它就不再是沒看過的資料。\n\n確定現在要看這條規則的 holdout 嗎?';
    if (!confirm(msg)) return;
    try {
      const out = await runner.call('holdout', { ...run.cfg, keys: [key] });
      run.holdouts[key] = { ...out.rules[0], range: out.holdout };
      addPeek(key);
      renderDetail();
    } catch (err) { toast(`holdout 計算失敗: ${err.message}`); }
  }

  let regions = {}, detailRegion = null;

  function detailNode() {
    if (!run?.selected) return null;
    const row = run.scan.rules.find((r) => r.key === run.selected);
    const ho = run.holdouts[row.key];
    const t = thresholds();
    return detailCard(row, t, {
      detail: run.detail, holdout: ho, devMinTrades: st.settings.devMin, peeksText: peeksText(row.key), title: st.mode === 'single' ? run.cfg.grid.name : null,
      holdoutRange: `${run.cfg.splitDate} 起`, onHoldout: revealHoldout,
      onClose: st.mode === 'grid' ? () => { run.selected = null; run.detail = null; renderDetail(); } : null,
    });
  }

  function renderDetail() {
    if (!regions.detail) return;
    clear(regions.detail);
    const n = detailNode();
    if (n) regions.detail.append(n);
  }

  function renderRules({ keepFocus = false } = {}) {
    if (!regions.rules) return;
    clear(regions.rules);
    regions.rules.append(rulesCard(run.scan, thresholds(), run.view, { onSelect: select, selected: run.selected, rerender: (o) => renderRules(o || {}) }));
    if (keepFocus) { const i = regions.rules.querySelector('input[aria-label="篩選規則"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
  }

  function csvOf(scan) {
    const head = ['rule', 'side', 'n', 'days', 'win', 'mean', 'median', 'avg_win', 'avg_loss', 'elig', 'stock_pass', 'opt_n', 'opt_win', 'opt_mean'];
    const row = (r) => [r.key, r.side, r.cons.n, r.cons.days, r.cons.win, r.cons.mean, '', r.cons.avgWin, r.cons.avgLoss, r.cons.elig, r.cons.stockPass, r.opt?.n ?? '', r.opt?.win ?? '', r.opt?.mean ?? ''];
    const esc = (v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [head, ...scan.rules.map(row)].map((r) => r.map(esc).join(',')).join('\n');
  }

  function renderResults() {
    regions = {}; detailRegion = null;
    if (!run) { renderEmpty(); return; }
    clear(resultsMount);
    const { scan, cfg } = run, t = thresholds();
    const single = scan.rules.length === 1 && st.mode === 'single';
    const head = h('div', { class: 'status', 'data-testid': 'dt-status' },
      h('strong', null, cfg.grid.name), ` · ${scan.tickers} 檔 × ${scan.rules.length} 條規則 · 開發集 ${scan.dev.first} → ${scan.dev.last}(${scan.dev.days.toLocaleString('en-US')} 個交易日) · ${run.seconds.toFixed(1)} 秒 · Holdout(${cfg.splitDate} 起)未被使用`);
    const notes = [];
    if (run.missing.length) notes.push(`找不到外部序列 ${run.missing.join('、')} 的資料,用到它的條件不會觸發。`);
    notes.push('股票池若是「今天」的成分股,會有存活者偏誤(下市、被剔除的公司不在樣本內),對逢低買進類規則有利。');
    resultsMount.append(head, h('div', { class: 'notice' }, h('ul', null, ...notes.map((n) => h('li', null, n)))));
    if (!single) {
      regions.summary = h('div'); regions.cands = h('div'); regions.detail = h('div'); regions.scatter = h('div'); regions.frontier = h('div'); regions.rules = h('div');
      regions.summary.append(summaryCard(scan, t));
      regions.cands.append(candidatesCard(scan, t, { onSelect: select, selected: run.selected }));
      regions.scatter.append(scatterCard(scan, t, run.view, { onSelect: select, selected: run.selected }));
      regions.frontier.append(frontierCard(scan, t, { onSelect: select }));
      resultsMount.append(regions.summary, regions.cands, regions.detail, regions.scatter, regions.frontier, regions.rules,
        h('div', null, h('button', { type: 'button', class: 'ghost', onClick: () => download(`${safeFilename(cfg.grid.name, 'scan')}.csv`, csvOf(scan), 'text/csv') }, '下載全部規則的結果(CSV)')));
      renderRules();
    } else {
      regions.detail = h('div');
      resultsMount.append(regions.detail);
    }
    detailRegion = regions.detail;
    renderDetail();
  }

  // ---- 組裝 ----

  dataMount = h('div'); ruleMount = h('div'); settingsMount = h('div');
  runBtn = h('button', { type: 'button', class: 'primary', id: 'dt-run', onClick: execute }, '執行規則');
  panelMount.append(section('資料', dataMount), section('規則', ruleMount), section('成交與驗收', settingsMount), h('div', { class: 'run-bar' }, runBtn));
  renderData(); renderRule(); renderSettings(); renderRunLabel(); renderEmpty();

  return {
    run: execute,
    /** 資料清單(內建標的)載入完成後呼叫,讓選單更新並預設選取 */
    refreshAssets() {
      const ids = assetsForPicker().map((a) => a.id);
      st.picked = new Set([...st.picked].filter((id) => ids.includes(id)));
      if (!st.picked.size) ids.slice(0, 40).forEach((id) => st.picked.add(id));
      renderData();
    },
    get mode() { return runner.mode; },
  };
}
