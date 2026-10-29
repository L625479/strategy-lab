// 「目標權重」分頁: 每天收盤算出各標的應占淨值的比例(可以 > 1 倍 = 融資槓桿、< 0 = 放空),隔天開盤調整。
// 帳戶會逐日計入融資利息、閒置現金利息、借券費與交易成本;成交慣例寫在 engine/weightsrun.js 的檔頭與說明文件。

import { BUILTIN_SERIES, makeFunctions } from '../engine/indicators.js';
import { WEIGHT_TEMPLATES, getWeightsTemplate } from '../engine/weightsTemplates.js';
import { buildWeightsData, compileWeights, emptyWeightsStrategy, normalizeWeightsStrategy } from '../engine/weights.js';
import { runWeights } from '../engine/weightsrun.js';
import { drawdownChart, equityChart, exposureChart, linkCharts, readTheme } from './charts.js';
import { $$, clear, download, h, isNum, money, num, pct, price, safeFilename, signClass } from './dom.js';
import { card, deltaLine, kpi, legendKey, monthlyCard } from './results.js';

const STORE = 'lab.w.v1';
const clone = (x) => JSON.parse(JSON.stringify(x));
const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 瀏覽器封鎖儲存空間時就不記 */ } };

const DEFAULTS = { capital: 100000, start: '', end: '', benchmark: '', carryIn: true };

export function createWeights({ panelMount, resultsMount, getAssets, getBars, toast }) {
  const saved = read(STORE) || {};
  let s = normalizeWeightsStrategy(saved.strategy || getWeightsTemplate('vol_ratio').strategy);
  let opts = { ...DEFAULTS, ...(saved.opts || {}) };
  let note = '';
  let last = null, view = null, running = false, runBtn;

  const persist = () => write(STORE, { strategy: s, opts });
  const labelled = (text, node) => h('label', { class: 'field' }, text, node);
  const field = (path, input) => { input.dataset.field = path; return h('div', { class: 'stack' }, input, h('div', { class: 'err-slot', dataset: { for: path } })); };
  const text = (path, value, onInput, { expr = false, placeholder = '' } = {}) => field(path, h('input', { type: 'text', value, class: expr ? 'expr' : '', placeholder, spellcheck: false, autocomplete: 'off', 'aria-label': path, onInput: (e) => { onInput(e.target.value); persist(); } }));
  const number = (path, value, onInput, attrs = {}) => field(path, h('input', { type: 'number', value: Number.isFinite(value) ? value : 0, step: 'any', ...attrs, 'aria-label': path, onInput: (e) => { onInput(e.target.value === '' ? 0 : Number(e.target.value)); persist(); } }));
  const section = (title, ...body) => h('details', { class: 'card', open: true }, h('summary', null, title), h('div', { class: 'body' }, ...body));
  const del = (label, fn) => h('button', { class: 'icon ghost', type: 'button', 'aria-label': label, title: '刪除', onClick: fn }, '×');
  const stack = (...kids) => h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, ...kids);

  const tickerSelect = (path, value, onChange) => {
    const assets = getAssets();
    const known = assets.some((a) => a.id === value);
    const sel = h('select', { 'aria-label': path, onChange: (e) => { onChange(e.target.value); persist(); render(); } },
      ...(known || !value ? [] : [h('option', { value, selected: true }, `${value}(沒有資料)`)]),
      ...assets.map((a) => h('option', { value: a.id, selected: a.id === value }, `${a.id} ${a.name}`)));
    return field(path, sel);
  };
  const seriesSelect = (path, value, onChange, { none = '' } = {}) => field(path, h('select', { 'aria-label': path, onChange: (e) => { onChange(e.target.value); persist(); } },
    ...(none ? [h('option', { value: '' }, none)] : []), ...s.series.map((x) => h('option', { value: x.name, selected: x.name === value }, x.name))));

  function syntaxHelp() {
    const funcs = makeFunctions({ c: new Float64Array(0) });
    return h('details', { class: 'syntax' }, h('summary', null, '語法說明: 權重運算式與可用名稱'),
      h('p', { class: 'hint' }, '每天收盤後求值,結果是「這個標的占淨值的目標比例」: 1 = 滿倉、2 = 2 倍槓桿(融資)、0 = 空手、-1 = 放空一倍。隔天開盤依目標調整(實際權重偏離目標超過「再平衡帶」才動)。結果是 NaN(指標還沒有足夠資料)當作 0。'),
      h('table', null,
        h('tr', null, h('td', null, '資料序列'), h('td', null, h('code', null, 'x_open x_high x_low x_close x_volume'), ' x 是序列名稱,例如 spy_close、oil_close')),
        h('tr', null, h('td', null, '第一個標的'), h('td', null, ...Object.entries(BUILTIN_SERIES).flatMap(([k, v]) => [h('code', { title: v }, k), ' ']), ' 是它的簡寫')),
        h('tr', null, h('td', null, '波動'), h('td', null, h('code', null, 'std(ret(close), 20)'), ' 近 20 日日報酬的樣本標準差;年化乘上 ', h('code', null, 'sqrt(252)'))),
        h('tr', null, h('td', null, '條件'), h('td', null, h('code', null, 'ifelse(close > sma(close, 200), 1.5, 0)'))),
        ...Object.entries(funcs).map(([name, d]) => h('tr', null, h('td', null, h('code', null, name)), h('td', null, d.doc.replace(/^[^ ]+ /, '')))),
      ));
  }

  function render() {
    clear(panelMount);
    const tpl = h('select', { 'aria-label': '範本', onChange: (e) => { const t = getWeightsTemplate(e.target.value); if (t) { s = normalizeWeightsStrategy(clone(t.strategy)); note = t.description; persist(); render(); } } },
      h('option', { value: '' }, '從範本開始…'), ...WEIGHT_TEMPLATES.map((t) => h('option', { value: t.id }, t.name)));
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { s = normalizeWeightsStrategy(JSON.parse(await f.text())); note = `已匯入「${s.name}」`; persist(); render(); } catch { toast('匯入失敗: 不是有效的權重策略 JSON'); }
    } });

    const seriesRows = s.series.map((x, i) => h('div', { class: 'list-row', style: { gridTemplateColumns: 'minmax(60px, 24%) 1fr 30px' } },
      text(`series[${i}].name`, x.name, (v) => { x.name = v; }, { placeholder: '名稱' }), tickerSelect(`series[${i}].ticker`, x.ticker, (v) => { x.ticker = v; }),
      del(`刪除序列 ${x.name}`, () => { s.series.splice(i, 1); persist(); render(); })));
    const weightRows = s.weights.map((w, i) => h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      h('div', { class: 'row' }, h('div', { style: { width: '110px' } }, seriesSelect(`weights[${i}].series`, w.series, (v) => { w.series = v; })), h('span', { class: 'muted' }, '的目標權重'), h('span', { class: 'grow' }), del('刪除', () => { s.weights.splice(i, 1); persist(); render(); })),
      text(`weights[${i}].expr`, w.expr, (v) => { w.expr = v; }, { expr: true, placeholder: '例如 min(2, 0.01 / std(ret(close), 20))' })));
    const paramRows = s.params.map((p, i) => h('div', { class: 'list-row param' }, text(`params[${i}].name`, p.name, (v) => { p.name = v; }, { placeholder: '名稱' }), number(`params[${i}].value`, p.value, (v) => { p.value = v; }), del(`刪除參數 ${p.name}`, () => { s.params.splice(i, 1); persist(); render(); })));
    const indRows = s.indicators.map((p, i) => h('div', { class: 'list-row' }, text(`indicators[${i}].name`, p.name, (v) => { p.name = v; }, { placeholder: '名稱' }), text(`indicators[${i}].expr`, p.expr, (v) => { p.expr = v; }, { expr: true, placeholder: '例如 std(ret(close), 20)' }), del(`刪除指標 ${p.name}`, () => { s.indicators.splice(i, 1); persist(); render(); })));
    const add = (label, fn) => h('div', null, h('button', { class: 'ghost', type: 'button', onClick: () => { fn(); persist(); render(); } }, label));
    const n = (path, label, get, set, attrs = {}) => h('div', { class: 'grow' }, labelled(label, number(path, get(), set, attrs)));
    const rateBody = s.rates.mode === 'series'
      ? h('div', { class: 'grow' }, labelled('利率序列(收盤價 ÷ 100 = 年利率,例如 ^IRX)', seriesSelect('rates.series', s.rates.series, (v) => { s.rates.series = v; }, { none: '請選擇…' })))
      : n('rates.constantPct', '固定年利率 (%)', () => s.rates.constantPct, (v) => { s.rates.constantPct = v; }, { min: 0 });

    panelMount.append(
      section('策略',
        stack(labelled('範本', tpl), note ? h('p', { class: 'hint', role: 'status' }, note) : null,
          labelled('策略名稱', text('name', s.name, (v) => { s.name = v; })),
          h('div', { class: 'row wrap' },
            h('button', { type: 'button', class: 'ghost', onClick: () => download(`${safeFilename(s.name, 'strategy')}.weights.json`, JSON.stringify(s, null, 2), 'application/json') }, '匯出 JSON'),
            h('button', { type: 'button', class: 'ghost', onClick: () => fileInput.click() }, '匯入 JSON'), fileInput))),
      section('資料序列(交易標的與只拿來當訊號的序列)',
        stack(...seriesRows, add('＋ 新增序列', () => s.series.push({ name: `s${s.series.length + 1}`, ticker: getAssets()[0]?.id || '' })),
          h('p', { class: 'hint' }, '有寫權重的序列才會被交易;其他(例如原油、波動率指數)只能在運算式裡當訊號用。內建清單沒有的標的,請在「策略回測」分頁上傳 CSV(會出現在這裡)。'))),
      section('目標權重', stack(...weightRows, add('＋ 新增權重', () => s.weights.push({ series: s.series[0]?.name || '', expr: '1' })))),
      section('參數與指標', stack(h('div', { class: 'sect-title' }, '參數'), ...paramRows, add('＋ 新增參數', () => s.params.push({ name: `p${s.params.length + 1}`, value: 20 })),
        h('div', { class: 'sect-title' }, '指標(由上往下計算,可以引用前面的)'), ...indRows, add('＋ 新增指標', () => s.indicators.push({ name: `ind${s.indicators.length + 1}`, expr: 'std(ret(close), 20)' })))),
      section('帳戶與成本',
        stack(h('div', { class: 'errors', id: 'w-errors', hidden: true, role: 'alert' }), h('div', { class: 'notice', id: 'w-warnings', hidden: true }),
          h('div', { class: 'row wrap' }, n('band', '再平衡帶 (%)', () => s.band, (v) => { s.band = v; }, { min: 0 }), n('maxGross', '總曝險上限 (倍)', () => s.maxGross, (v) => { s.maxGross = v; }, { min: 0 })),
          h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.allowShort, onChange: (e) => { s.allowShort = e.target.checked; persist(); } }), '允許放空(權重可以 < 0)'),
          h('div', { class: 'row wrap' }, n('warmupBars', '暖機根數(這之前權重視為 0)', () => s.warmupBars, (v) => { s.warmupBars = Math.round(v); }, { min: 0 }), n('costs.sideBps', '單邊成本 bps', () => s.costs.sideBps, (v) => { s.costs.sideBps = v; }, { min: 0 })),
          h('div', { class: 'sect-title' }, '利率(閒置現金賺、融資付「利率 + 利差」)'),
          h('div', { class: 'row wrap' }, h('div', { style: { width: '120px' } }, labelled('來源', h('select', { 'aria-label': '利率來源', onChange: (e) => { s.rates.mode = e.target.value; persist(); render(); } }, h('option', { value: 'constant', selected: s.rates.mode === 'constant' }, '固定利率'), h('option', { value: 'series', selected: s.rates.mode === 'series' }, '利率序列')))), rateBody),
          h('div', { class: 'row wrap' }, n('costs.financingSpreadPct', '融資利差 (%/年)', () => s.costs.financingSpreadPct, (v) => { s.costs.financingSpreadPct = v; }, { min: 0 }), n('costs.borrowFeePct', '借券費 (%/年,空單)', () => s.costs.borrowFeePct, (v) => { s.costs.borrowFeePct = v; }, { min: 0 })),
          h('p', { class: 'hint' }, '利息每根 K 棒結算: 日曆天數 ÷ 365,依前一根收盤時的餘額。閒置自有現金 = 淨值 − 多單市值;融資 = 多單市值 − 淨值;放空所得不計息。回測不模擬追繳保證金,淨值 ≤ 0 就視為爆倉。'))),
      section('回測期間與比較',
        stack(h('div', { class: 'row wrap' }, n('capital', '起始資金', () => opts.capital, (v) => { opts.capital = v; }, { min: 0 }),
          h('div', { class: 'grow' }, labelled('基準(買入持有)', seriesSelect('benchmark', opts.benchmark, (v) => { opts.benchmark = v; }, { none: '無' })))),
        h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, labelled('開始日', field('start', h('input', { type: 'date', value: opts.start, 'aria-label': '開始日', onChange: (e) => { opts.start = e.target.value; persist(); } })))),
          h('div', { class: 'grow' }, labelled('結束日', field('end', h('input', { type: 'date', value: opts.end, 'aria-label': '結束日', onChange: (e) => { opts.end = e.target.value; persist(); } }))))),
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: opts.carryIn, onChange: (e) => { opts.carryIn = e.target.checked; persist(); } }), '策略從資料開頭就開始跑,只取開始日之後的績效(部位延續下來)'),
        h('p', { class: 'hint' }, '勾選時,開始日只是「績效從哪天起算」,和「凍結的規則在這段期間的表現」同一個意思;不勾則在開始日當天空手重新開始。'))),
      syntaxHelp(),
    );
    runBtn = h('button', { type: 'button', class: 'primary', id: 'w-run', onClick: run }, running ? '計算中…' : '執行回測');
    panelMount.append(h('div', { class: 'run-bar' }, runBtn));
  }

  function showErrors(errors, warnings) {
    $$('.invalid', panelMount).forEach((el) => el.classList.remove('invalid'));
    $$('.err-slot', panelMount).forEach((el) => { el.textContent = ''; el.className = 'err-slot'; });
    for (const { field: f, message } of errors) {
      const input = panelMount.querySelector(`[data-field="${CSS.escape(f)}"]`);
      if (input) input.classList.add('invalid');
      const slot = panelMount.querySelector(`.err-slot[data-for="${CSS.escape(f)}"]`);
      if (slot && !slot.textContent) { slot.textContent = message; slot.className = 'err-slot field-error'; }
    }
    const box = panelMount.querySelector('#w-errors'), warn = panelMount.querySelector('#w-warnings');
    box.hidden = !errors.length; clear(box);
    if (errors.length) box.append(h('strong', null, `有 ${errors.length} 個問題需要修正:`), h('ul', null, ...errors.slice(0, 6).map((e) => h('li', null, e.message))));
    warn.hidden = !warnings.length; clear(warn);
    if (warnings.length) warn.append(h('ul', null, ...warnings.map((x) => h('li', null, x))));
  }

  const message = (kind, body) => { view?.destroy(); view = null; clear(resultsMount); resultsMount.append(kind === 'error' ? h('div', { class: 'errors', role: 'alert' }, body) : body); };

  function empty() {
    message('info', h('div', { class: 'card empty' }, h('h2', null, '目標權重策略'),
      h('p', null, '不寫進出場訊號,而是每天算出「每個標的應該占淨值多少」。可以大於 1 倍(融資槓桿)、小於 0(放空),帳戶會逐日計入融資利息、閒置現金利息、借券費與交易成本。'),
      h('ol', null, h('li', null, '從範本開始(波動管理、波動目標、趨勢濾網…),或自己寫權重運算式'), h('li', null, '選好資料序列(交易標的、訊號序列、利率),設定再平衡帶與成本'), h('li', null, '按「執行回測」,看績效、曝險、融資用量與每一次調整'))));
  }

  async function run() {
    if (running) return;
    const c = compileWeights(s);
    showErrors(c.errors, c.warnings);
    if (!c.ok) { message('error', `策略有 ${c.errors.length} 個問題,請先在左邊修正(紅字欄位)。第一個: ${c.errors[0].message}`); return; }
    if (!(opts.capital > 0)) { message('error', '起始資金必須大於 0。'); return; }
    running = true; runBtn.disabled = true; runBtn.textContent = '計算中…'; resultsMount.style.opacity = '0.5';
    try {
      const tickers = [...new Set(c.compiled.strategy.series.map((x) => x.ticker))];
      const have = new Set(getAssets().map((a) => a.id));
      const missing = tickers.filter((t) => !have.has(t));
      if (missing.length) throw new Error(`沒有 ${missing.join('、')} 的價格資料。內建清單沒有的標的,請在「策略回測」分頁上傳 CSV,或在左邊換成其他標的。`);
      const barsByTicker = Object.fromEntries(await Promise.all(tickers.map(async (t) => [t, await getBars(t)])));
      const data = buildWeightsData(c.compiled, barsByTicker);
      const bench = c.compiled.strategy.series.some((x) => x.name === opts.benchmark) ? opts.benchmark : '';
      const result = runWeights(c.compiled, data, { capital: opts.capital, start: opts.start, end: opts.end, benchmark: bench, carryIn: opts.carryIn });
      last = { result, compiled: c.compiled, warnings: c.warnings, assets: getAssets(), opts: { ...opts } };
      draw();
    } catch (err) { message('error', err.message || String(err)); } finally { running = false; runBtn.disabled = false; runBtn.textContent = '執行回測'; resultsMount.style.opacity = ''; }
  }

  // ---- 結果 ----

  function monthEndTable(r) {
    const rows = [];
    for (let i = 0; i < r.dates.length; i++) if (i === r.dates.length - 1 || r.dates[i].slice(0, 7) !== r.dates[i + 1].slice(0, 7)) rows.push(i);
    return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['月底', '策略權益', '買入持有', r.bench ? `基準 ${r.bench.id}` : null, '總曝險(倍)', '策略回撤'].filter(Boolean).map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((i) => h('tr', null, h('td', null, r.dates[i]), h('td', null, money(r.equity[i])), h('td', null, money(r.buyHold[i])), r.bench ? h('td', null, money(r.bench.equity[i])) : null,
        h('td', null, num(r.run.gross[i], 2)), h('td', { class: signClass(r.drawdown[i]) }, pct(r.drawdown[i], 1)))))));
  }

  function draw() {
    view?.destroy();
    clear(resultsMount);
    const { result: r, compiled, warnings, opts: o } = last;
    const t = readTheme(), charts = [];
    const m = r.metrics, b = r.buyHoldMetrics, a = r.account;
    const dpp = (x, y) => (isNum(x) && isNum(y) ? (x - y) * 100 : NaN);
    const prim = compiled.strategy.series.find((x) => x.name === compiled.primary);
    resultsMount.append(h('div', { class: 'status', 'data-testid': 'w-status' }, h('strong', null, compiled.strategy.name), ` · ${compiled.weights.map((w) => w.series).join('、')} · ${r.dates[0]} → ${r.dates.at(-1)} · 起始資金 ${money(r.capital)} · ${o.carryIn ? '策略從資料開頭就在跑' : '從開始日空手開始'}`));
    const notes = [...warnings, ...r.warnings];
    if (notes.length) resultsMount.append(h('div', { class: 'notice', role: 'status' }, h('ul', null, notes.map((x) => h('li', null, x)))));
    resultsMount.append(h('div', { class: 'kpis' },
      kpi('總報酬', h('span', { class: signClass(m.totalReturn) }, pct(m.totalReturn, 1, { sign: true })), deltaLine(dpp(m.totalReturn, b.totalReturn), ' pp', `相較 ${prim?.ticker || ''} 買入持有`)),
      kpi('年化報酬 (CAGR)', pct(m.cagr, 1, { sign: true }), deltaLine(dpp(m.cagr, b.cagr), ' pp', `相較買入持有`)),
      kpi('夏普比率', num(m.sharpe, 2), deltaLine(isNum(m.sharpe) && isNum(b.sharpe) ? m.sharpe - b.sharpe : NaN, '', '相較買入持有', { digits: 2 })),
      kpi('最大回撤', pct(m.maxDrawdown, 1), deltaLine(dpp(m.maxDrawdown, b.maxDrawdown), ' pp', '相較買入持有(正 = 較淺)')),
      kpi('年化波動', pct(m.vol, 1), deltaLine(dpp(m.vol, b.vol), ' pp', '相較買入持有', { goodWhenUp: false })),
      kpi('平均曝險', `${a.avgGross.toFixed(2)}×`, h('div', { class: 'delta' }, `最高 ${a.maxGross.toFixed(2)}× · 淨 ${a.avgNet.toFixed(2)}×`)),
      kpi('使用融資的日子', pct(a.shareLevered, 0), h('div', { class: 'delta' }, a.shareLevered ? `平均借入淨值的 ${pct(a.avgBorrowedWhenLevered, 0)}` : '沒有使用融資')),
      kpi('成交筆數', String(a.fills), h('div', { class: 'delta' }, `年換手 ${isNum(a.turnoverPerYear) ? `${a.turnoverPerYear.toFixed(1)}×` : '—'}`))));

    const eqLines = [{ key: 'strategy', label: '策略', color: t.s[0], values: r.equity }, { key: 'bh', label: `買入持有 ${prim?.ticker || ''}`, color: t.muted, values: r.buyHold }];
    if (r.bench) eqLines.push({ key: 'bench', label: `基準 ${r.bench.id}(買入持有)`, color: t.s[1], values: r.bench.equity });
    const eqBox = h('div', { class: 'chart eq', role: 'img', 'aria-label': '權益曲線圖;完整數值請切換「表格檢視」' }), tbl = h('div', { hidden: true });
    let log = false, tableOn = false, api;
    const logBtn = h('button', { type: 'button', class: 'ghost', 'aria-pressed': 'false', onClick: () => { log = !log; logBtn.setAttribute('aria-pressed', String(log)); logBtn.textContent = log ? '對數座標 ✓' : '對數座標'; api?.setLog(log); } }, '對數座標');
    const tblBtn = h('button', { type: 'button', class: 'ghost', onClick: () => { tableOn = !tableOn; tblBtn.textContent = tableOn ? '圖表檢視' : '表格檢視'; eqBox.hidden = tableOn; tbl.hidden = !tableOn; if (tableOn && !tbl.firstChild) tbl.append(monthEndTable(r)); } }, '表格檢視');
    const ddBox = h('div', { class: 'chart dd', role: 'img', 'aria-label': '回撤圖' }), exBox = h('div', { class: 'chart dd', role: 'img', 'aria-label': '曝險圖' });
    resultsMount.append(
      card('權益曲線', { legend: h('div', { class: 'legend' }, eqLines.map((l) => legendKey(l.label, l.color))), actions: h('div', { class: 'row' }, logBtn, tblBtn) }, eqBox, tbl),
      card('回撤(距離歷史高點)', { legend: h('div', { class: 'legend' }, legendKey('策略', t.s[0], 'sw'), legendKey('買入持有', t.muted)) }, ddBox),
      card('曝險(占淨值的倍數)', { legend: h('div', { class: 'legend' }, legendKey('總曝險', t.s[0], 'sw'), legendKey('淨曝險(有放空時)', t.muted)) }, exBox));
    queueMicrotask(() => {
      api = equityChart(eqBox, { dates: r.dates, lines: eqLines }, t); charts.push(api.chart);
      const dd = drawdownChart(ddBox, { dates: r.dates, strategy: r.drawdown, buyHold: r.buyHoldDrawdown }, t); charts.push(dd.chart);
      const ex = exposureChart(exBox, { dates: r.dates, gross: r.run.gross, net: r.run.net }, t); charts.push(ex.chart);
      linkCharts(api.chart, dd.chart); linkCharts(api.chart, ex.chart);
    });

    // 帳戶明細
    const per = (x) => (r.dates.length > 1 ? x / r.capital / ((Date.parse(r.dates.at(-1)) - Date.parse(r.dates[0])) / (365.25 * 86400000)) : NaN);
    const acct = [['融資利息', a.financing], ['閒置現金利息(收入)', a.interest], ['借券費', a.borrowFee], ['交易成本', a.costs]];
    resultsMount.append(card('帳戶明細(整段期間)', {}, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['項目', '金額', '占起始資金(年化)'].map((x, i) => h('th', { class: i ? '' : 'left' }, x)))),
      h('tbody', null, acct.map(([k, v]) => h('tr', null, h('td', { class: 'left' }, k), h('td', null, money(v)), h('td', null, pct(per(v), 2)))),
        h('tr', null, h('td', { class: 'left' }, h('strong', null, '淨額(收入 − 支出)')), h('td', null, money(a.interest - a.financing - a.borrowFee - a.costs)), h('td', null, pct(per(a.interest - a.financing - a.borrowFee - a.costs), 2))))))));

    resultsMount.append(monthlyCard({ monthly: r.monthly }, { theme: t }));

    // 指標對照
    const cols = [['策略', m], [`買入持有 ${prim?.ticker || ''}`, b], ...(r.benchMetrics ? [[`基準 ${r.bench.id}`, r.benchMetrics]] : [])];
    const rows = [['總報酬', (x) => pct(x.totalReturn, 2, { sign: true })], ['年化報酬 (CAGR)', (x) => pct(x.cagr, 2, { sign: true })], ['年化波動', (x) => pct(x.vol, 2)], ['夏普比率 (無風險利率 0)', (x) => num(x.sharpe, 2)],
      ['索提諾比率', (x) => num(x.sortino, 2)], ['卡瑪比率', (x) => num(x.calmar, 2)], ['最大回撤', (x) => pct(x.maxDrawdown, 2)], ['最長水下期間 (天)', (x) => String(x.maxDdDays)],
      ['最佳單日', (x) => pct(x.bestDay, 2, { sign: true })], ['最差單日', (x) => pct(x.worstDay, 2, { sign: true })], ['期末權益', (x) => money(x.finalEquity)]];
    resultsMount.append(h('details', { class: 'card' }, h('summary', null, '詳細指標'), h('div', { class: 'body' }, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, '指標'), cols.map(([k]) => h('th', null, k)))), h('tbody', null, rows.map(([label, f]) => h('tr', null, h('td', null, label), cols.map(([, x]) => h('td', null, f(x)))))))))));

    // 每一次調整
    const fills = r.run.fills, LIMIT = 200;
    const csv = () => download('rebalances.csv', ['date,series,shares,price,notional,cost,from_weight,to_weight', ...fills.map((f) => [f.date, f.series, f.shares, f.price, f.notional, f.cost, f.fromWeight, f.toWeight].join(','))].join('\n'), 'text/csv');
    resultsMount.append(card(`每一次調整(${fills.length} 筆)`, { actions: fills.length ? h('button', { type: 'button', class: 'ghost', onClick: csv }, '下載 CSV') : null },
      fills.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['日期', '標的', '買 / 賣', '股數', '成交價', '金額', '成本', '權重(調整前 → 後)'].map((x, i) => h('th', { class: i < 3 ? 'left' : '' }, x)))),
        h('tbody', null, fills.slice(0, LIMIT).map((f) => h('tr', null, h('td', { class: 'left' }, f.date), h('td', { class: 'left' }, f.series), h('td', { class: 'left' }, f.shares > 0 ? '買' : '賣'),
          h('td', null, num(Math.abs(f.shares), 2)), h('td', null, price(f.price)), h('td', null, money(f.notional)), h('td', null, money(f.cost)), h('td', null, `${f.fromWeight.toFixed(2)} → ${f.toWeight.toFixed(2)}`)))))) : h('p', { class: 'muted' }, '這段期間內沒有任何調整(權重一直在再平衡帶內,或權重一直是 0)。'),
      fills.length > LIMIT ? h('p', { class: 'hint' }, `只顯示前 ${LIMIT} 筆,共 ${fills.length} 筆(完整內容請下載 CSV)。`) : null));
    view = { destroy: () => charts.forEach((c) => { try { c.remove(); } catch { /* 已移除 */ } }) };
  }

  render();
  empty();
  return { run, redraw: () => { if (last) draw(); }, refreshAssets: () => render() };
}
