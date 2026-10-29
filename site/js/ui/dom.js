// 小型 DOM 工具與格式化函式。所有文字一律走 textContent / createTextNode,絕不用 innerHTML,
// 因為標的名稱、策略名稱、CSV 內容都是不可信的資料。

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'for') el.htmlFor = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'selected', 'type', 'min', 'max', 'step', 'placeholder', 'rows', 'accept', 'multiple', 'hidden', 'open', 'spellcheck', 'autocomplete'].includes(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 去抖動。回傳的函式帶 flush(): 有尚未執行的呼叫就立刻執行(離開頁面時用,避免最後的修改遺失) */
export function debounce(fn, ms) {
  let timer = null, pending = null;
  const wrapped = (...args) => { pending = args; clearTimeout(timer); timer = setTimeout(() => { timer = null; const a = pending; pending = null; fn(...a); }, ms); };
  wrapped.flush = () => { if (timer !== null) { clearTimeout(timer); timer = null; const a = pending; pending = null; fn(...a); } };
  return wrapped;
}

/** 檔名裡 Windows/macOS/Linux 不允許的字元換成底線(保留中文等一般字元) */
export const safeFilename = (name, fallback = 'file') => {
  const cleaned = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80);
  return cleaned || fallback;
};

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- 格式化 ---------------------------------------------------------------

const NA = '—';
export const isNum = (x) => typeof x === 'number' && !Number.isNaN(x);

export function pct(x, digits = 1, { sign = false } = {}) {
  if (!isNum(x)) return NA;
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '-∞';
  const v = (x * 100).toFixed(digits);
  return `${sign && x > 0 ? '+' : ''}${v}%`;
}

export function num(x, digits = 2) {
  if (!isNum(x)) return NA;
  if (!Number.isFinite(x)) return x > 0 ? '∞' : '-∞';
  return x.toFixed(digits);
}

export function money(x) {
  if (!isNum(x)) return NA;
  const abs = Math.abs(x);
  const s = abs >= 1000 ? Math.round(abs).toLocaleString('en-US') : abs.toFixed(2);
  return `${x < 0 ? '-' : ''}${s}`;
}

export function price(x) {
  if (!isNum(x)) return NA;
  const a = Math.abs(x);
  return x.toLocaleString('en-US', { maximumFractionDigits: a >= 1000 ? 0 : a >= 100 ? 2 : a >= 1 ? 3 : 5 });
}

export const signClass = (x) => (!isNum(x) || x === 0 ? '' : x > 0 ? 'pos' : 'neg');
export const arrow = (x) => (!isNum(x) || x === 0 ? '' : x > 0 ? '▲' : '▼');
