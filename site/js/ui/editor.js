// 策略編輯器: 範本、參數、指標、進出場規則、止損止盈、倉位與成本。
// 輸入時只更新資料、不重繪(游標不會跑掉);結構改變(新增/刪除/換範本)才重繪。

import { BUILTIN_SERIES, makeFunctions } from '../engine/indicators.js';
import { TEMPLATES, emptyStrategy, getTemplate, normalizeStrategy } from '../engine/strategy.js';
import { $$, clear, download, h, safeFilename } from './dom.js';
import { deleteStrategy, listStrategies, saveStrategy } from './store.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

export function createEditor(mount, { onChange = () => {}, onShare = () => {}, python = null } = {}) {
  let s = emptyStrategy();
  let note = '';
  // Python 策略(伺服器端執行 strategies_py/ 裡的 .py 檔): python = { health(), list() };沒有給就表示這個網站沒有這個功能
  const py = { health: null, list: null, loading: false, error: '' };
  async function loadPython() {
    py.loading = true; py.error = '';
    render();
    try {
      py.health = python ? await python.health() : { available: false, reason: '這個網站不是由 tools/serve.mjs 提供,沒有 Python 策略功能。請用 node tools/serve.mjs site 8080 啟動。' };
      py.list = py.health.available ? await python.list() : [];
    } catch (err) { py.error = err.message; py.list = []; }
    py.loading = false;
    render();
  }

  const changed = () => onChange(clone(s));

  /** 一個輸入欄位 + 錯誤訊息槽。field 用來把驗證錯誤對應回來。 */
  function field(path, input) {
    input.dataset.field = path;
    return h('div', { class: 'stack' }, input, h('div', { class: 'err-slot', dataset: { for: path } }));
  }

  const textInput = (path, value, onInput, { expr = false, placeholder = '' } = {}) => field(path, h('input', {
    type: 'text', value, class: expr ? 'expr' : '', placeholder, spellcheck: false, autocomplete: 'off',
    'aria-label': path, onInput: (e) => { onInput(e.target.value); changed(); },
  }));

  const numInput = (path, value, onInput, attrs = {}) => field(path, h('input', {
    type: 'number', value: Number.isFinite(value) ? value : 0, step: 'any', ...attrs, 'aria-label': path,
    onInput: (e) => { onInput(e.target.value === '' ? 0 : Number(e.target.value)); changed(); },
  }));

  const labelled = (text, node) => h('label', { class: 'field' }, text, node);

  // ---- 區塊 ----------------------------------------------------------------

  function paramsBlock() {
    const rows = s.params.map((p, i) => h('div', { class: 'list-row param' },
      textInput(`params[${i}].name`, p.name, (v) => { p.name = v; }, { placeholder: '名稱' }),
      numInput(`params[${i}].value`, p.value, (v) => { p.value = v; }),
      h('button', { class: 'icon ghost', type: 'button', 'aria-label': `刪除參數 ${p.name}`, title: '刪除', onClick: () => { s.params.splice(i, 1); render(); changed(); } }, '×')));
    return [
      ...rows,
      h('div', null, h('button', { class: 'ghost', type: 'button', onClick: () => { s.params.push({ name: `p${s.params.length + 1}`, value: 10 }); render(); changed(); } }, '＋ 新增參數')),
    ];
  }

  function indicatorsBlock() {
    const rows = s.indicators.map((ind, i) => h('div', { class: 'list-row' },
      textInput(`indicators[${i}].name`, ind.name, (v) => { ind.name = v; }, { placeholder: '名稱' }),
      textInput(`indicators[${i}].expr`, ind.expr, (v) => { ind.expr = v; }, { expr: true, placeholder: '例如 ema(close, fast)' }),
      h('button', { class: 'icon ghost', type: 'button', 'aria-label': `刪除指標 ${ind.name}`, title: '刪除', onClick: () => { s.indicators.splice(i, 1); render(); changed(); } }, '×')));
    return [
      ...rows,
      h('div', null, h('button', { class: 'ghost', type: 'button', onClick: () => { s.indicators.push({ name: `ind${s.indicators.length + 1}`, expr: 'sma(close, 20)' }); render(); changed(); } }, '＋ 新增指標')),
    ];
  }

  function stopBlock(key, label) {
    const stop = s[key];
    const body = h('div', { class: 'row wrap' });
    const draw = () => {
      clear(body);
      if (stop.mode === 'pct') body.append(h('div', { class: 'grow' }, labelled('距離成交價 %', numInput(`${key}.pct`, stop.pct, (v) => { stop.pct = v; }, { min: 0 }))));
      if (stop.mode === 'atr') {
        body.append(h('div', { class: 'grow' }, labelled('ATR 週期', numInput(`${key}.atrN`, stop.atrN, (v) => { stop.atrN = v; }, { min: 1 }))),
          h('div', { class: 'grow' }, labelled('ATR 倍數', numInput(`${key}.atrMult`, stop.atrMult, (v) => { stop.atrMult = v; }, { min: 0 }))));
      }
      if (stop.mode === 'expr') body.append(h('div', { class: 'grow' }, labelled('表達式(結果是距離成交價的 %)', textInput(`${key}.expr`, stop.expr, (v) => { stop.expr = v; }, { expr: true, placeholder: 'atr(14) / close * 100 * 2' }))));
    };
    draw();
    const select = h('select', {
      'aria-label': `${label}方式`, onChange: (e) => { stop.mode = e.target.value; draw(); changed(); },
    }, ...[['none', '不設定'], ['pct', '固定百分比'], ['atr', 'ATR 倍數'], ['expr', '自訂表達式']].map(([v, t]) => h('option', { value: v, selected: stop.mode === v }, t)));
    return h('div', { class: 'stack', dataset: { field: key } },
      h('div', { class: 'row wrap' }, h('div', { style: { width: '90px' } }, label), h('div', { class: 'grow' }, select)),
      body, h('div', { class: 'err-slot', dataset: { for: key } }));
  }

  function syntaxHelp() {
    const funcs = makeFunctions({ c: new Float64Array(0) });
    return h('details', { class: 'syntax' },
      h('summary', null, '語法說明(可用的變數與函式)'),
      h('p', { class: 'hint' }, '規則是一行運算式,結果為真(非 0)就觸發。收盤後判斷,下一根開盤成交。'),
      h('table', null,
        h('tr', null, h('td', null, '價格'), h('td', null, ...Object.entries(BUILTIN_SERIES).flatMap(([k, v]) => [h('code', { title: v }, k), ' ']))),
        h('tr', null, h('td', null, '運算'), h('td', null, h('code', null, '+ - * / %'), ' ', h('code', null, '< <= > >= == !='), ' ', h('code', null, 'and or not'))),
        h('tr', null, h('td', null, '歷史值'), h('td', null, h('code', null, 'close[1]'), ' 代表前一根(只能是 0 以上的整數,不能看未來)')),
        ...Object.entries(funcs).map(([name, d]) => h('tr', null, h('td', null, h('code', null, name)), h('td', null, d.doc.replace(/^[^ ]+ /, '')))),
        h('tr', null, h('td', null, '範例'), h('td', null, h('code', null, 'cross_above(ema(close,12), ema(close,26)) and rsi(close,14) < 70'))),
      ));
  }

  // ---- Python 策略 ----------------------------------------------------------------

  function pythonBlock() {
    if (!py.health && !py.loading) queueMicrotask(loadPython);
    const picked = (py.list || []).find((x) => x.id === s.python.id);
    const ok = py.health?.available;
    const params = picked && !picked.error ? picked.params : [];
    return [
      h('div', { class: 'errors', hidden: !py.error, role: 'alert' }, py.error),
      py.loading ? h('p', { class: 'status', role: 'status' }, '讀取 Python 策略清單中…') : null,
      !py.loading && py.health && !ok ? h('div', { class: 'notice', 'data-testid': 'py-unavailable' }, py.health.reason) : null,
      ok ? h('p', { class: 'hint', 'data-testid': 'py-status' }, `Python ${py.health.python}、pandas ${py.health.pandas} · 策略資料夾 ${py.health.dir}`) : null,
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, field('python.id', h('select', { 'aria-label': 'Python 策略', disabled: !ok, onChange: (e) => {
          const prev = (py.list || []).find((x) => x.id === s.python.id);
          s.python.id = e.target.value; s.python.params = {};
          const next = (py.list || []).find((x) => x.id === e.target.value);
          const generic = s.name === emptyStrategy().name || s.name === prev?.name || TEMPLATES.some((t) => t.name === s.name);      // 名稱還是預設的 / 範本的 → 換成 Python 策略的名稱;使用者自己取的名字不動
          if (next && generic) s.name = next.name;
          render(); changed();
        } },
        h('option', { value: '' }, ok ? (py.list.length ? '選擇一個 Python 策略…' : '資料夾裡還沒有策略') : '(沒有可用的 Python 策略)'),
        ...(py.list || []).map((x) => h('option', { value: x.id, disabled: Boolean(x.error), selected: x.id === s.python.id }, `${x.name}${x.name !== x.id ? `(${x.id})` : ''}${x.error ? ' — 載入失敗' : ''}`))))),
        h('button', { type: 'button', class: 'ghost', disabled: py.loading, onClick: loadPython }, '重新整理')),
      picked?.error ? h('div', { class: 'errors' }, `${picked.file}: ${picked.error}`) : null,
      picked && !picked.error && picked.doc ? h('p', { class: 'hint', style: { whiteSpace: 'pre-wrap' } }, picked.doc) : null,
      !picked && s.python.id && ok ? h('div', { class: 'notice' }, `資料夾裡找不到「${s.python.id}」(可能被改名或刪除)。請重新選擇。`) : null,
      params.length ? h('div', { class: 'sect-title' }, '策略參數(預設值來自策略檔的 PARAMS)') : null,
      ...params.map((p) => {
        const value = Object.hasOwn(s.python.params, p.name) ? s.python.params[p.name] : p.value;
        const set = (v) => { s.python.params[p.name] = v; changed(); };
        return h('label', { class: 'field' }, p.name, typeof p.value === 'number'
          ? numInput(`python.params.${p.name}`, value, set)
          : textInput(`python.params.${p.name}`, String(value), set));
      }),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.python.checkLookahead, 'aria-label': '檢查偷看未來', onChange: (e) => { s.python.checkLookahead = e.target.checked; changed(); } }),
        '檢查策略有沒有偷看未來資料(把資料截短、最多多跑 7 次;前面的訊號若被後面的資料改變就警告,建議保持開啟)'),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.allowShort, onChange: (e) => { s.allowShort = e.target.checked; changed(); } }), '允許做空(策略回傳 -1 或 entry_short 時才會放空)'),
      h('p', { class: 'hint' }, '把用 Python 寫的策略放進 strategies_py/ 資料夾(範本: _template.py),存檔後按「重新整理」。約定與範例見 README「用 Python 寫策略」。手續費、滑價、投入比例、止損止盈照樣在下面設定;策略只負責「什麼時候進出」。'),
    ];
  }

  // ---- 策略庫(儲存/載入/匯出/匯入/分享) ----------------------------------------

  function library() {
    const saved = listStrategies();
    const pick = h('select', { 'aria-label': '我的策略' },
      h('option', { value: '' }, saved.length ? `我的策略(${saved.length})…` : '尚未儲存任何策略'),
      ...saved.map((x) => h('option', { value: x.name }, x.name)));
    pick.disabled = !saved.length;
    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onChange: async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        s = normalizeStrategy(raw.strategy || raw);
        note = `已匯入「${s.name}」`;
        render(); changed();
      } catch { note = '匯入失敗: 不是有效的策略 JSON 檔'; render(); }
    } });
    return h('div', { class: 'stack', style: { gap: '8px' } },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, pick),
        h('button', { type: 'button', disabled: !saved.length, onClick: () => {
          const found = saved.find((x) => x.name === pick.value);
          if (found) { s = clone(found); note = `已載入「${found.name}」`; render(); changed(); }
        } }, '載入'),
        h('button', { type: 'button', class: 'ghost', disabled: !saved.length, onClick: () => {
          if (pick.value && confirm(`刪除「${pick.value}」?`)) { deleteStrategy(pick.value); note = `已刪除「${pick.value}」`; render(); }
        } }, '刪除')),
      h('div', { class: 'row wrap' },
        h('button', { type: 'button', onClick: () => { note = saveStrategy(s) ? `已儲存「${s.name}」到這個瀏覽器` : '儲存失敗: 瀏覽器封鎖了儲存空間'; render(); } }, '儲存策略'),
        h('button', { type: 'button', class: 'ghost', onClick: () => download(`${safeFilename(s.name, 'strategy')}.strategy.json`, JSON.stringify(s, null, 2), 'application/json') }, '匯出 JSON'),
        h('button', { type: 'button', class: 'ghost', onClick: () => fileInput.click() }, '匯入 JSON'),
        h('button', { type: 'button', class: 'ghost', onClick: () => onShare() }, '複製分享連結'),
        fileInput),
      note ? h('p', { class: 'hint', role: 'status' }, note) : null);
  }

  // ---- 主繪製 -------------------------------------------------------------------

  function render() {
    clear(mount);
    const templateSelect = h('select', {
      'aria-label': '從範本開始', onChange: (e) => {
        const t = getTemplate(e.target.value);
        if (t) { s = clone(t.strategy); note = ''; render(); changed(); }
      },
    }, h('option', { value: '' }, '從範本開始…'), ...TEMPLATES.map((t) => h('option', { value: t.id }, t.name)));

    const matched = TEMPLATES.find((t) => JSON.stringify(t.strategy) === JSON.stringify(s));
    const body = h('div', { class: 'body' },
      h('div', { class: 'errors', id: 'editor-errors', hidden: true, role: 'alert' }),
      h('div', { class: 'notice', id: 'editor-warnings', hidden: true }),
      h('div', { class: 'seg', role: 'group', 'aria-label': '策略來源' },
        h('button', { type: 'button', 'aria-pressed': String(s.source === 'rules'), onClick: () => { if (s.source !== 'rules') { s.source = 'rules'; render(); changed(); } } }, '規則策略(範本 / 自訂)'),
        h('button', { type: 'button', 'aria-pressed': String(s.source === 'python'), onClick: () => { if (s.source !== 'python') { s.source = 'python'; render(); changed(); } } }, 'Python 策略')),
      s.source === 'rules' ? h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, labelled('範本', templateSelect)),
        h('div', { class: 'grow' }, labelled('策略名稱', textInput('name', s.name, (v) => { s.name = v; })))) : labelled('策略名稱', textInput('name', s.name, (v) => { s.name = v; })),
      s.source === 'rules' && matched ? h('p', { class: 'hint' }, matched.description) : null,

      ...(s.source === 'python' ? pythonBlock() : [
        h('div', { class: 'sect-title' }, '參數(可以在規則裡直接用名稱)'),
        ...paramsBlock(),
        h('div', { class: 'sect-title' }, '指標(由上往下計算,可以引用前面的)'),
        ...indicatorsBlock(),

        h('div', { class: 'sect-title' }, '進場條件'),
        labelled('做多(為真就在下一根開盤買進)', textInput('entry.long', s.entry.long, (v) => { s.entry.long = v; }, { expr: true, placeholder: '例如 cross_above(fast, slow)' })),
        s.allowShort ? labelled('做空(為真就在下一根開盤放空)', textInput('entry.short', s.entry.short, (v) => { s.entry.short = v; }, { expr: true })) : null,
        h('div', { class: 'sect-title' }, '出場條件(留空 = 只靠止損/止盈出場)'),
        labelled('多單出場', textInput('exit.long', s.exit.long, (v) => { s.exit.long = v; }, { expr: true })),
        s.allowShort ? labelled('空單出場', textInput('exit.short', s.exit.short, (v) => { s.exit.short = v; }, { expr: true })) : null,
        h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: s.allowShort, onChange: (e) => { s.allowShort = e.target.checked; render(); changed(); } }), '允許做空'),
      ]),

      h('div', { class: 'sect-title' }, '止損 / 止盈(距離以成交價計算)'),
      stopBlock('stopLoss', '止損'),
      stopBlock('takeProfit', '止盈'),

      h('div', { class: 'sect-title' }, '部位與成本'),
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, labelled('每次投入淨值 %', numInput('sizing.pctEquity', s.sizing.pctEquity, (v) => { s.sizing.pctEquity = v; }, { min: 0 }))),
        h('div', { class: 'grow' }, labelled('暖機根數', numInput('warmupBars', s.warmupBars, (v) => { s.warmupBars = Math.round(v); }, { min: 0 })))),
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, labelled('手續費 bps(單邊)', numInput('costs.commissionBps', s.costs.commissionBps, (v) => { s.costs.commissionBps = v; }, { min: 0 }))),
        h('div', { class: 'grow' }, labelled('滑價 bps(單邊)', numInput('costs.slippageBps', s.costs.slippageBps, (v) => { s.costs.slippageBps = v; }, { min: 0 })))),
      h('p', { class: 'hint' }, '1 bps = 0.01%。美股 ETF 約 1~5;台股買賣手續費 + 賣出證交稅約合計 40~45。'),

      s.source === 'rules' ? syntaxHelp() : null,
      h('div', { class: 'sect-title' }, '策略庫'),
      library());

    mount.append(h('details', { class: 'card', open: true }, h('summary', null, '策略'), body));
  }

  // ---- 對外介面 -------------------------------------------------------------------

  function showErrors(errors = [], warnings = []) {
    $$('.invalid', mount).forEach((el) => el.classList.remove('invalid'));
    $$('.err-slot', mount).forEach((el) => { el.textContent = ''; el.className = 'err-slot'; });
    const box = mount.querySelector('#editor-errors'), warn = mount.querySelector('#editor-warnings');
    for (const { field: f, message } of errors) {
      const input = mount.querySelector(`[data-field="${CSS.escape(f)}"]`);
      if (input && input.tagName === 'INPUT') input.classList.add('invalid');
      const slot = mount.querySelector(`.err-slot[data-for="${CSS.escape(f)}"]`);
      if (slot && !slot.textContent) { slot.textContent = message; slot.classList.add('field-error'); }
    }
    box.hidden = !errors.length;
    clear(box);
    if (errors.length) box.append(h('strong', null, `有 ${errors.length} 個問題需要修正:`), h('ul', null, ...errors.slice(0, 8).map((e) => h('li', null, e.message)), errors.length > 8 ? h('li', null, `…還有 ${errors.length - 8} 個`) : null));
    warn.hidden = !warnings.length;
    clear(warn);
    if (warnings.length) warn.append(h('ul', null, ...warnings.map((w) => h('li', null, w))));
  }

  render();
  return {
    getStrategy: () => clone(s),
    setStrategy: (next) => { s = normalizeStrategy(next); note = ''; render(); },
    showErrors,
    refreshLibrary: render,
  };
}
