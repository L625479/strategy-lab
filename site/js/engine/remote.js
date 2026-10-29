// 「輸入代號自動抓資料」的網站端: 呼叫本機伺服器的 /api(tools/api.mjs)。純靜態託管時沒有這個 API,apiAvailable() 回傳 false,
// 網站就只提供上傳 CSV。請求都帶 X-Strategy-Lab 標頭(伺服器用它擋掉別的網站的跨網域請求)。網址用相對路徑,網站放在子目錄也能用。

import { toBars } from './data.js';

const HEAD = { 'X-Strategy-Lab': '1' };

async function getJson(path, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(path, { headers: HEAD, cache: 'no-store', signal });
  let body = null;
  try { body = await res.json(); } catch { /* 不是 JSON(例如靜態伺服器的 404 頁) */ }
  if (!res.ok) throw new Error(body?.error || `伺服器回應 HTTP ${res.status}`);
  return body;
}

/**
 * 這個網站是不是由 tools/serve.mjs 提供(有 /api)。任何失敗都當作沒有。
 * marked: 首頁有沒有 serve.mjs 加的標記(<meta name="strategy-lab-api">);沒有就不必發請求(純靜態託管上會是一個 404)。
 */
export async function apiAvailable({ marked = true, ...opts } = {}) {
  if (!marked) return false;
  try { const j = await getJson('api/health', opts); return j?.ok === true && j.service === 'strategy-lab'; } catch { return false; }
}

/** 以代號或名稱搜尋 → [{ symbol, name, type, exchange }] */
export const searchSymbols = (q, opts = {}) => getJson(`api/search?q=${encodeURIComponent(q)}`, opts);

/** 下載一個代號的日線(調整後價格)。fresh = 略過伺服器的快取。回傳 { bars, info }。 */
export async function downloadSeries(symbol, { fresh = false, ...opts } = {}) {
  const j = await getJson(`api/prices?symbol=${encodeURIComponent(symbol)}${fresh ? '&fresh=1' : ''}`, opts);
  return {
    bars: toBars(j),
    info: { symbol: j.symbol, name: j.name || j.symbol, source: j.source, updated: j.updated, currency: j.currency || '', exchange: j.exchange || '', warn: j.warn || '', stats: j.stats || {} },
  };
}
