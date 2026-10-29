// 標的與期間: 單一標的 / 投資組合、搜尋與選擇、權重、期間、起始資金、基準、CSV 上傳。

import { clear, h } from './dom.js';

const SYMBOL_RE = /^[A-Za-z0-9^.=\-]{1,20}$/;      // 和 tools/yahoo.mjs 的 SYMBOL_RE 相同
const NON_ASCII = /[^\u0000-\u007f]/;
const NON_ASCII_SEARCH = 'Yahoo 的搜尋不支援中文。請輸入英文名稱(例如 TSMC、Taiwan Semiconductor)或代號(例如 2330 或 2330.TW)。';   // 和 tools/api.mjs 相同
export const MAX_ASSETS = 8; // 圖表的類別色票只有 8 個固定順序的槽位,所以組合上限 8 檔

const PRESETS = [['近 1 年', 1], ['近 3 年', 3], ['近 5 年', 5], ['近 10 年', 10], ['全部', 0]];
const clone = (x) => JSON.parse(JSON.stringify(x));

function shiftYears(iso, years) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export function createTargets(mount, {
  onChange = () => {}, onUpload = async () => { throw new Error('尚未支援'); }, onRemove = async () => {},
  onSearch = async () => [], onDownload = async () => { throw new Error('尚未支援'); }, onDownloaded = () => {},
} = {}) {
  let assets = [];                   // [{id,name,category,first,last,n,warn}]
  let t = { mode: 'single', items: [], start: '', end: '', capital: 100000, benchmark: '' };
  let query = '', message = '';
  // 網路搜尋與下載(需要由 tools/serve.mjs 提供網站): on = null 還不知道 / true 可用 / false 純靜態託管
  const net = { on: null, results: [], loading: false, error: '', busy: '' };
  let netMount = null, searchTimer = null, searchSeq = 0;
  const slots = new Map();           // id -> 1..8: 顏色跟著標的,不跟著排名

  const byId = (id) => assets.find((a) => a.id === id);
  const changed = () => onChange(clone(t));

  function slotOf(id) {
    if (!slots.has(id)) {
      const used = new Set(slots.values());
      for (let k = 1; k <= MAX_ASSETS; k++) if (!used.has(k)) { slots.set(id, k); break; }
      if (!slots.has(id)) slots.set(id, 8);
    }
    return slots.get(id);
  }

  function setItems(items) {
    const keep = new Set(items.map((i) => i.id));
    for (const id of [...slots.keys()]) if (!keep.has(id)) slots.delete(id);
    t.items = items;
    items.forEach((i) => slotOf(i.id));
  }

  function toggle(id) {
    const has = t.items.some((i) => i.id === id);
    if (t.mode === 'single') {
      if (!has) { setItems([{ id, weight: 1 }]); message = ''; }
    } else if (has) {
      if (t.items.length > 1) setItems(t.items.filter((i) => i.id !== id));
    } else if (t.items.length >= MAX_ASSETS) {
      message = `投資組合最多 ${MAX_ASSETS} 檔(圖表只有 ${MAX_ASSETS} 個固定顏色,再多就分不清楚了)`;
    } else {
      setItems([...t.items, { id, weight: 1 }]); message = '';
    }
    render(); changed();
  }

  function availableRange() {
    const sel = t.items.map((i) => byId(i.id)).filter(Boolean);
    if (!sel.length) return null;
    return { first: sel.map((a) => a.first).sort().at(-1), last: sel.map((a) => a.last).sort().at(0), firstAny: sel.map((a) => a.first).sort()[0], lastAny: sel.map((a) => a.last).sort().at(-1) };
  }

  function picker() {
    const q = query.trim().toLowerCase();
    const shown = assets.filter((a) => matches(a, q));
    const groups = [...new Set(shown.map((a) => a.category))];
    const selected = new Set(t.items.map((i) => i.id));
    const list = h('div', { class: 'picker', role: 'listbox', 'aria-label': '標的清單', 'aria-multiselectable': t.mode === 'portfolio' });
    if (!assets.length) list.append(h('p', { class: 'hint', style: { padding: '10px' } }, net.on
      ? '還沒有任何標的。在上面的搜尋框輸入代號(例如 AAPL、2330.TW、^GSPC、BTC-USD)或公司名稱,就會自動從網路下載日線資料。也可以用下方的「上傳 CSV」。'
      : '目前沒有內建的行情資料。請用下方的「上傳 CSV」加入你自己的資料(例如從 TradingView 匯出)。'));
    for (const g of groups) {
      list.append(h('div', { class: 'group' }, g));
      for (const a of shown.filter((x) => x.category === g)) {
        const row = h('div', { class: 'pick-row' },
          h('button', { type: 'button', role: 'option', 'aria-pressed': selected.has(a.id), 'aria-selected': selected.has(a.id), title: a.updated ? `${a.name}\n下載於 ${a.updated}` : a.name, onClick: () => toggle(a.id) },
            h('span', { class: 'sym' }, a.id), h('span', { class: 'nm' }, a.name)));
        if (a.source === 'yahoo' && net.on) {
          row.append(h('button', { type: 'button', class: 'pick-del ghost', 'aria-label': `重新下載 ${a.id}`, title: `重新從網路下載最新資料(目前資料下載於 ${a.updated || '更早'})`, disabled: Boolean(net.busy), onClick: () => download(a.id, { fresh: true }) }, '更新'));
        }
        if (a.removable) {
          row.append(h('button', { type: 'button', class: 'pick-del ghost', 'aria-label': `刪除${a.source === 'yahoo' ? '下載的' : '上傳的'}資料 ${a.id}`, title: '從這個瀏覽器刪除這份資料', onClick: () => { if (confirm(`刪除「${a.id}」的資料?`)) onRemove(a.id); } }, '刪除'));
        }
        list.append(row);
      }
    }
    if (assets.length && !shown.length) list.append(h('p', { class: 'hint', style: { padding: '10px' } }, '找不到符合的標的'));
    return list;
  }

  // ---- 從網路找(Yahoo Finance) ----

  function netSection() {
    const q = query.trim();
    if (!q) return null;
    if (net.on === false) {
      return assets.some((a) => matches(a, q.toLowerCase())) ? null
        : h('p', { class: 'hint', role: 'status' }, '清單裡沒有這個標的,而且這個網站目前沒有啟用自動下載(純靜態模式)。要輸入代號自動抓資料,請用 node tools/serve.mjs site 8080 啟動;或用下方的「上傳 CSV」。');
    }
    if (!net.on) return null;
    const sym = q.toUpperCase();
    const have = (id) => Boolean(byId(id));
    const rows = [];
    const row = (symbol, name, extra) => h('div', { class: 'pick-row net-row' },
      h('button', { type: 'button', 'aria-label': `下載 ${symbol}`, disabled: Boolean(net.busy), onClick: () => download(symbol) },
        h('span', { class: 'sym' }, symbol), h('span', { class: 'nm' }, [name, extra].filter(Boolean).join(' · ')), h('span', { class: 'nm' }, net.busy === symbol ? '下載中…' : '下載')));
    for (const r of net.results) if (!have(r.symbol)) rows.push(row(r.symbol, r.name, [r.exchange, r.type].filter(Boolean).join(' ')));
    if (SYMBOL_RE.test(sym) && !have(sym) && !net.results.some((r) => r.symbol === sym)) rows.push(row(sym, '直接用這個代號(按 Enter 也可以)', ''));
    const box = h('div', { class: 'picker', 'aria-label': '網路搜尋結果', 'data-testid': 'net-results' }, h('div', { class: 'group' }, '從網路找(Yahoo Finance)'), ...rows);
    if (net.loading) box.append(h('p', { class: 'hint', style: { padding: '4px 10px' } }, '搜尋中…'));
    else if (net.error) box.append(h('p', { class: 'field-error', style: { padding: '4px 10px' } }, net.error));
    else if (!rows.length) box.append(h('p', { class: 'hint', style: { padding: '4px 10px' } }, '沒有找到,換個關鍵字或直接輸入代號(台股要加 .TW,例如 2330.TW)。'));
    return box;
  }

  const matches = (a, q) => !q || a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);

  function renderNet() {
    if (!netMount) return;
    clear(netMount);
    const n = netSection();
    if (n) netMount.append(n);
  }

  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchSeq++;
    net.results = []; net.error = ''; net.loading = false;
    const q = query.trim();
    if (!net.on || q.length < 2) return;
    if (NON_ASCII.test(q)) { net.error = NON_ASCII_SEARCH; return; }                  // 不必送出去: Yahoo 的搜尋對中文一律 400
    net.loading = true;
    const seq = searchSeq;
    searchTimer = setTimeout(async () => {
      try { const r = await onSearch(q); if (seq !== searchSeq) return; net.results = r; net.error = ''; } catch (err) { if (seq !== searchSeq) return; net.results = []; net.error = err.message; }
      net.loading = false;
      renderNet();
    }, 400);
  }

  async function download(symbol, { fresh = false } = {}) {
    if (net.busy) return;
    net.busy = symbol; message = `正在下載 ${symbol}…`; render();
    try {
      const res = await onDownload(symbol, { fresh });
      message = res.message || '';
      query = ''; net.results = []; net.error = ''; net.loading = false; searchSeq++;
      net.busy = '';
      addAsset(res.asset, !fresh);
      onDownloaded({ id: res.asset.id, fresh });                        // 下載完成 → 通知外面(自動用目前的策略跑回測)
      return;
    } catch (err) { message = `下載失敗: ${err.message}`; }
    net.busy = '';
    render();
  }

  function submitQuery() {
    const q = query.trim();
    if (!q) return;
    const exact = assets.find((a) => a.id.toLowerCase() === q.toLowerCase());
    if (exact) { toggle(exact.id); return; }
    if (net.on && SYMBOL_RE.test(q)) download(q.toUpperCase());
  }

  function chips() {
    const box = h('div', { class: 'chips' });
    for (const item of t.items) {
      const a = byId(item.id) || { id: item.id, name: '' };
      box.append(h('div', { class: 'chip' },
        h('span', { class: 'dot', style: { background: `var(--s${slotOf(item.id)})` }, 'aria-hidden': 'true' }),
        h('div', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } },
          h('strong', null, a.id), ' ', h('span', { class: 'muted small' }, a.name),
          a.warn ? h('span', { class: 'warn-tag', title: a.warn }, '資料警告') : null),
        t.mode === 'portfolio'
          ? h('div', { class: 'w' }, h('input', { type: 'number', min: 0, step: 'any', value: item.weight, 'aria-label': `${a.id} 權重`, onInput: (e) => { item.weight = Math.max(0, Number(e.target.value) || 0); changed(); } }))
          : h('span'),
        t.mode === 'portfolio' && t.items.length > 1
          ? h('button', { class: 'icon ghost', type: 'button', 'aria-label': `移除 ${a.id}`, onClick: () => toggle(item.id) }, '×')
          : h('span')));
    }
    return box;
  }

  function render() {
    clear(mount);
    const range = availableRange();
    const hasWarn = t.items.map((i) => byId(i.id)).filter((a) => a?.warn);
    const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onChange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const res = await onUpload(file);
        message = res.message || '';
        addAsset(res.asset, true);
      } catch (err) { message = `上傳失敗: ${err.message}`; render(); }
    } });

    const body = h('div', { class: 'body' },
      h('div', { class: 'row wrap' },
        h('div', { class: 'seg', role: 'group', 'aria-label': '模式' },
          h('button', { type: 'button', 'aria-pressed': t.mode === 'single', onClick: () => { if (t.mode !== 'single') { t.mode = 'single'; setItems(t.items.slice(0, 1)); render(); changed(); } } }, '單一標的'),
          h('button', { type: 'button', 'aria-pressed': t.mode === 'portfolio', onClick: () => { if (t.mode !== 'portfolio') { t.mode = 'portfolio'; render(); changed(); } } }, '投資組合')),
        h('span', { class: 'hint' }, t.mode === 'single' ? '只看一檔標的的績效' : `最多 ${MAX_ASSETS} 檔,按權重分配資金`)),

      h('input', { type: 'text', placeholder: net.on ? '輸入代號或公司名稱,例如 AAPL、2330.TW、Tesla…' : '搜尋代號或名稱…', value: query, 'aria-label': '搜尋標的', autocomplete: 'off', spellcheck: false,
        onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitQuery(); } },
        onInput: (e) => {
          query = e.target.value;
          const pos = e.target.selectionStart;
          scheduleSearch();
          render();
          const again = mount.querySelector('input[type="text"]');
          again.focus(); again.setSelectionRange(pos, pos);
        } }),
      net.on ? h('p', { class: 'hint' }, '清單裡沒有的標的,輸入代號按 Enter(或點搜尋結果)就會自動下載,資料來自 Yahoo Finance。') : null,
      picker(),
      (netMount = h('div'), netMount),
      message ? h('p', { class: 'hint', role: 'status' }, message) : null,
      chips(),
      t.mode === 'portfolio' && t.items.length > 1
        ? h('div', { class: 'row' }, h('button', { type: 'button', class: 'ghost', onClick: () => { t.items.forEach((i) => { i.weight = 1; }); render(); changed(); } }, '平均權重'), h('span', { class: 'hint' }, '權重會自動換算成 100%'))
        : null,
      hasWarn.length ? h('div', { class: 'notice' }, hasWarn.map((a) => h('div', null, `${a.id}: ${a.warn}`))) : null,

      h('div', { class: 'sect-title' }, '回測期間'),
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('label', { class: 'field' }, '開始', h('input', { type: 'date', value: t.start, 'aria-label': '開始日期', onChange: (e) => { t.start = e.target.value; changed(); } }))),
        h('div', { class: 'grow' }, h('label', { class: 'field' }, '結束', h('input', { type: 'date', value: t.end, 'aria-label': '結束日期', onChange: (e) => { t.end = e.target.value; changed(); } })))),
      h('div', { class: 'chips-row' }, PRESETS.map(([label, years]) => h('button', { type: 'button', class: 'toggle-chip', onClick: () => {
        const r = availableRange();
        t.end = '';
        t.start = years && r ? shiftYears(r.lastAny, years) : '';
        render(); changed();
      } }, label))),
      range ? h('p', { class: 'hint' }, `所選資料範圍: ${range.firstAny} ~ ${range.lastAny}。開始日之前的資料仍會用來預熱指標。`) : null,

      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('label', { class: 'field' }, '起始資金', h('input', { type: 'number', min: 1, step: 'any', value: t.capital, 'aria-label': '起始資金', onInput: (e) => { t.capital = Number(e.target.value) || 0; changed(); } }))),
        h('div', { class: 'grow' }, h('label', { class: 'field' }, '額外比較基準(買入持有)', h('select', { 'aria-label': '比較基準', onChange: (e) => { t.benchmark = e.target.value; changed(); } },
          h('option', { value: '' }, '無'), ...assets.map((a) => h('option', { value: a.id, selected: t.benchmark === a.id }, `${a.id} ${a.name}`)))))),

      h('div', { class: 'row wrap' },
        h('button', { type: 'button', onClick: () => fileInput.click() }, '上傳 CSV…'),
        h('span', { class: 'hint' }, '需要 time/date、open、high、low、close 欄位(TradingView、Yahoo 匯出都可)'),
        fileInput));

    mount.append(h('details', { class: 'card', open: true }, h('summary', null, '標的與期間'), body));
    renderNet();
  }

  function addAsset(asset, select) {
    const i = assets.findIndex((a) => a.id === asset.id);
    if (i >= 0) assets[i] = asset; else assets.push(asset);
    assets.sort((a, b) => (a.removable ? 0 : 1) - (b.removable ? 0 : 1)); // 穩定排序,使用者上傳與下載的排最前面
    if (select) {
      if (t.mode === 'single') setItems([{ id: asset.id, weight: 1 }]);
      else if (!t.items.some((x) => x.id === asset.id) && t.items.length < MAX_ASSETS) setItems([...t.items, { id: asset.id, weight: 1 }]);
    }
    render(); changed();
  }

  render();
  return {
    get: () => clone(t),
    set(next) {
      t = { mode: next.mode === 'portfolio' ? 'portfolio' : 'single', items: [], start: next.start || '', end: next.end || '', capital: Number(next.capital) > 0 ? Number(next.capital) : 100000, benchmark: next.benchmark || '' };
      const valid = (next.items || []).filter((i) => byId(i.id)).slice(0, t.mode === 'single' ? 1 : MAX_ASSETS);
      setItems(valid.map((i) => ({ id: i.id, weight: Number(i.weight) >= 0 ? Number(i.weight) : 1 })));
      if (t.benchmark && !byId(t.benchmark)) t.benchmark = '';
      render();
    },
    setAssets(list) { assets = list.slice(); render(); },
    /** 伺服器有沒有提供自動下載(/api);知道之後重畫,搜尋框的提示才會對 */
    setNetwork(on) { net.on = Boolean(on); render(); },
    addAsset,
    removeAsset(id) {
      assets = assets.filter((a) => a.id !== id);
      setItems(t.items.filter((i) => i.id !== id));
      render(); changed();
    },
    colorSlot: slotOf,
    asset: byId,
    list: () => assets.slice(),
    hasAssets: () => assets.length > 0,
  };
}
