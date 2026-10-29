// Yahoo Finance(非官方 API)的日線下載、清理與品質檢查,給本機伺服器的 /api 用(Node,零依賴)。
// 清理邏輯是 tools/fetch_prices.py 的逐行移植,兩邊用同一份標準答案測試(tests/test_yahoo_golden.py、tests-js/yahoo.test.js):
//   調整後價格: 開高低依 adjclose / close 同比例換算(處理股利與分割),回測才不會被除息日的跳空騙到
//   丟掉空值與非正價格、修正高低價與開收矛盾的 K 棒、丟掉交易所當地「今天」的 K 棒(可能還沒收完)、同一天多筆只留最後一筆
//   品質閘門: 開收價相同但有振幅的 K 棒太多 = 收盤價疑似過期(Yahoo 外匯曾經有六成這種 K 棒)

export const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
export const SEARCH_URL = 'https://query2.finance.yahoo.com/v1/finance/search';
export const STALE_EXCLUDE = 0.25, STALE_WARN = 0.05, MIN_BARS = 250, MAX_AGE_DAYS = 10;
export const MIN_BARS_ON_DEMAND = 30;                       // 使用者自己輸入的標的: 上市不久也讓他看,但少於 250 根會警告
const USER_AGENT = 'Mozilla/5.0 (strategy-lab data fetch)';
export const SYMBOL_RE = /^[A-Za-z0-9^.=\-]{1,20}$/;         // Yahoo 的代號只會用到這些字元(^GSPC、CL=F、BTC-USD、2330.TW)

export class FetchError extends Error {
  constructor(message, { status = 0 } = {}) { super(message); this.name = 'FetchError'; this.status = status; }
}

// ---- 下載 ---------------------------------------------------------------------

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 呼叫 Yahoo chart API。429 / 5xx 與連線錯誤會退避重試;其他狀態碼直接丟出(帶 status)。 */
export async function fetchChart(symbol, years, now, { fetchImpl = fetch, retries = 3, sleep = sleepMs, timeoutMs = 20000 } = {}) {
  const nowSec = Math.floor(now.getTime() / 1000);
  const params = new URLSearchParams({
    period1: String(nowSec - (Math.trunc(years * 366) + 10) * 86400), period2: String(nowSec + 86400),
    interval: '1d', events: 'div,splits', includeAdjustedClose: 'true',
  });
  const retryable = [429, 500, 502, 503, 504];
  let last = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    let resp = null;
    try {
      resp = await fetchImpl(`${CHART_URL}${encodeURIComponent(symbol)}?${params}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) { last = e; }                                          // 連線錯誤 / 逾時: 重試
    if (resp) {
      if (retryable.includes(resp.status)) last = new FetchError(`HTTP ${resp.status}`, { status: resp.status });
      else if (resp.status !== 200) throw new FetchError(`HTTP ${resp.status}`, { status: resp.status });
      else return await resp.json();
    }
    if (attempt < retries - 1) await sleep(2 ** attempt * 1000);
  }
  throw new FetchError(`重試 ${retries} 次仍失敗: ${last?.message || last}`, { status: last?.status || 0 });
}

/** 從 Yahoo 回應取出 { ts, o, h, l, c, v, adj, offset, meta }。缺值是 null。 */
export function parseChart(payload) {
  const chart = payload?.chart || {};
  if (chart.error) throw new FetchError(`Yahoo 錯誤: ${JSON.stringify(chart.error)}`, { status: chart.error.code === 'Not Found' ? 404 : 0 });
  const result = chart.result?.[0];
  if (!result || !result.timestamp?.length) throw new FetchError('Yahoo 沒有回傳任何 K 棒', { status: 404 });
  const q = result.indicators.quote[0];
  const adjList = result.indicators.adjclose?.[0]?.adjclose;
  const out = {
    ts: result.timestamp, o: q.open ?? null, h: q.high ?? null, l: q.low ?? null, c: q.close ?? null, v: q.volume ?? null,
    adj: adjList && adjList.length ? adjList : (q.close ?? null),
    offset: result.meta?.gmtoffset || 0,
    meta: result.meta || {},
  };
  for (const k of ['o', 'h', 'l', 'c', 'adj']) {
    if (out[k] !== null && out[k].length !== out.ts.length) throw new FetchError(`Yahoo 回傳的 ${k} 長度與時間戳不一致`);
  }
  return out;
}

/** Python 的 float(f"{x:.6g}"): 取 6 位有效數字,剛好在中間時進位到偶數(JS 的 toPrecision 會進位到較大的數,兩邊會差 1)。 */
export function sig6(x) {
  if (!Number.isFinite(x) || x === 0) return x;
  const [mant, exp] = Math.abs(x).toExponential(99).split('e');      // 100 位有效數字: 雙精度的精確十進位展開
  const digits = mant.replace('.', '');
  if (digits[6] === '5' && /^0*$/.test(digits.slice(7))) {          // 恰好在兩個 6 位數的正中間(例如 100000.5)
    let n = BigInt(digits.slice(0, 6));
    if (n % 2n === 1n) n += 1n;
    return Math.sign(x) * Number(`${n}e${Number(exp) - 5}`);
  }
  return Number(x.toPrecision(6));
}

const isoDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const missing = (v) => v === null || v === undefined;

/** 清理並換算成調整後價格。todayLocal 是交易所當地「今天」的日期字串。回傳 { series, stats }。 */
export function buildSeries(parsed, todayLocal) {
  const d = [], o = [], h = [], l = [], c = [], v = [];
  const stats = { raw: parsed.ts.length, null: 0, nonpositive: 0, repaired: 0, partial_dropped: 0 };
  for (let i = 0; i < parsed.ts.length; i++) {
    let [ro, rh, rl, rc, adj] = ['o', 'h', 'l', 'c', 'adj'].map((k) => (parsed[k] === null ? null : parsed[k][i]));
    if ([ro, rh, rl, rc, adj].some(missing)) { stats.null++; continue; }
    if (Math.min(ro, rh, rl, rc, adj) <= 0) { stats.nonpositive++; continue; }
    const date = isoDate(parsed.ts[i] + parsed.offset);
    if (date >= todayLocal) { stats.partial_dropped++; continue; }
    const k = adj / rc;
    ro *= k; rh *= k; rl *= k; rc = adj;
    const hi = Math.max(ro, rh, rl, rc), lo = Math.min(ro, rh, rl, rc);
    if (hi !== rh || lo !== rl) { stats.repaired++; rh = hi; rl = lo; }
    const vol = parsed.v !== null && !missing(parsed.v[i]) ? parsed.v[i] : 0;
    d.push(date); o.push(sig6(ro)); h.push(sig6(rh)); l.push(sig6(rl)); c.push(sig6(rc)); v.push(Math.trunc(vol));
  }
  const seen = new Map();                                            // 同一天出現多筆(例如夏令時間切換)只留最後一筆
  d.forEach((date, i) => seen.set(date, i));
  const keep = [...seen.values()].sort((a, b) => a - b);
  const pick = (a) => keep.map((i) => a[i]);
  const series = { d: pick(d), o: pick(o), h: pick(h), l: pick(l), c: pick(c), v: pick(v) };
  const n = series.d.length;
  let stale = 0;
  for (let i = 0; i < n; i++) if (Math.abs(series.o[i] - series.c[i]) < 1e-9 && series.h[i] > series.l[i]) stale++;
  Object.assign(stats, { n, duplicates: d.length - n, stale_share: n ? stale / n : 0 });
  return { series, stats };
}

/** Python 的 f"{x:.0%}": 四捨五入到整數百分比,剛好在中間時進位到偶數(Math.round 會進位到較大的數)。 */
function pct0(x) {
  const v = x * 100, f = Math.floor(v), diff = v - f;
  return `${diff < 0.5 ? f : diff > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1}%`;
}

/** 回傳 { ok, warn, reason }。minBars 預設與 Python 版相同(250);使用者輸入的標的放寬到 30,但少於 250 會警告。 */
export function verdict(series, stats, todayLocal, { minBars = MIN_BARS } = {}) {
  if (stats.n < minBars) return { ok: false, warn: '', reason: `有效 K 棒只有 ${stats.n} 根(至少需要 ${minBars} 根)` };
  const share = stats.stale_share;
  if (share > STALE_EXCLUDE) return { ok: false, warn: '', reason: `${pct0(share)} 的 K 棒開盤價等於收盤價,收盤價疑似過期` };
  const warns = [];
  if (minBars < MIN_BARS && stats.n < MIN_BARS) warns.push(`只有 ${stats.n} 根 K 棒,指標與統計的參考價值有限`);
  if (share > STALE_WARN) warns.push(`${pct0(share)} 的 K 棒開盤價等於收盤價,收盤價可能過期,績效可能失真`);
  const age = Math.round((Date.parse(todayLocal) - Date.parse(series.d.at(-1))) / 86400000);
  if (age > MAX_AGE_DAYS) warns.push(`最新資料是 ${series.d.at(-1)},距今 ${age} 天`);
  return { ok: true, warn: warns.join(';'), reason: '' };
}

/**
 * 下載一個代號的日線並清理。通過品質檢查回傳網站用的 JSON,否則丟出 FetchError(message 是給使用者看的原因)。
 */
export async function loadSymbol(symbol, { years = 26, now = new Date(), fetchImpl = fetch, sleep = sleepMs, minBars = MIN_BARS_ON_DEMAND } = {}) {
  const parsed = parseChart(await fetchChart(symbol, years, now, { fetchImpl, sleep }));
  const todayLocal = isoDate(now.getTime() / 1000 + parsed.offset);
  const { series, stats } = buildSeries(parsed, todayLocal);
  const v = verdict(series, stats, todayLocal, { minBars });
  if (!v.ok) throw new FetchError(v.reason, { status: 422 });
  const m = parsed.meta;
  return {
    symbol: m.symbol || symbol.toUpperCase(), name: m.shortName || m.longName || symbol.toUpperCase(),
    source: 'Yahoo Finance(非官方 API)', adjusted: true, updated: now.toISOString().slice(0, 10),
    currency: m.currency || '', exchange: m.fullExchangeName || m.exchangeName || '', type: m.instrumentType || '',
    warn: v.warn, stats: { n: stats.n, repaired: stats.repaired, null: stats.null, dropped_today: stats.partial_dropped, duplicates: stats.duplicates, stale_share: stats.stale_share },
    ...series,
  };
}

// ---- 搜尋 ---------------------------------------------------------------------

const TYPES = { EQUITY: '股票', ETF: 'ETF', INDEX: '指數', CRYPTOCURRENCY: '加密貨幣', CURRENCY: '外匯', FUTURE: '期貨', MUTUALFUND: '基金' };

/** 以代號或名稱搜尋(Yahoo 的搜尋 API)。回傳 [{ symbol, name, type, exchange }],最多 8 筆;回應格式不如預期時回傳空陣列。 */
export async function searchSymbols(q, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const params = new URLSearchParams({ q, quotesCount: '10', newsCount: '0', listsCount: '0', enableFuzzyQuery: 'false' });
  const resp = await fetchImpl(`${SEARCH_URL}?${params}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (resp.status === 429) throw new FetchError('Yahoo 暫時限流,請稍後再試', { status: 429 });
  if (resp.status !== 200) throw new FetchError(`HTTP ${resp.status}`, { status: resp.status });
  const json = await resp.json();
  const seen = new Set(), out = [];
  for (const x of Array.isArray(json?.quotes) ? json.quotes : []) {
    if (typeof x?.symbol !== 'string' || !SYMBOL_RE.test(x.symbol) || !TYPES[x.quoteType] || seen.has(x.symbol)) continue;
    seen.add(x.symbol);
    out.push({ symbol: x.symbol, name: String(x.longname || x.shortname || x.symbol).slice(0, 80), type: TYPES[x.quoteType], exchange: String(x.exchDisp || x.exchange || '').slice(0, 30) });
    if (out.length >= 8) break;
  }
  return out;
}
