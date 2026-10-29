// 本機伺服器的 /api: 讓網站「輸入代號就自動去找資料」。瀏覽器不能直接呼叫 Yahoo(跨網域限制),所以由這台只聽 127.0.0.1 的小伺服器代抓。
//   GET /api/health                     → { ok, service, version }(網站用它判斷有沒有這個功能;純靜態託管時這個網址是 404)
//   GET /api/search?q=apple             → [{ symbol, name, type, exchange }]
//   GET /api/prices?symbol=AAPL&years=26 → 清理後的日線 JSON(見 tools/yahoo.mjs 的 loadSymbol)
// 安全: 只接受 GET;Host 必須是 127.0.0.1 / localhost(防 DNS rebinding);必須帶 X-Strategy-Lab 標頭
// (自訂標頭會讓別的網站的跨網域請求先被瀏覽器的預檢擋下,而這裡不回應預檢);代號只接受 Yahoo 代號會用到的字元,
// 只會連到固定的 Yahoo 主機,不會依輸入組出任意網址。

import { FetchError, SYMBOL_RE, loadSymbol, searchSymbols } from './yahoo.mjs';

const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
const HOUR = 3600e3;
export const NON_ASCII_SEARCH = 'Yahoo 的搜尋不支援中文。請輸入英文名稱(例如 TSMC、Taiwan Semiconductor)或代號(例如 2330 或 2330.TW)。';

function explain(err, symbol) {
  if (err instanceof FetchError) {
    if (err.status === 404) return [404, `Yahoo 找不到代號「${symbol}」。請確認拼寫: 台股要加 .TW(例如 2330.TW)、港股 .HK、加密貨幣用 BTC-USD、指數用 ^GSPC。也可以改用上方的名稱搜尋。`];
    if (err.status === 429) return [503, 'Yahoo 暫時限流(請求太頻繁),等一兩分鐘再試。'];
    if (err.status === 422) return [422, `「${symbol}」不收錄: ${err.message}。這種資料算出來的績效不可靠;要用的話請自己匯出 CSV 上傳。`];
    return [502, `從 Yahoo 抓「${symbol}」失敗: ${err.message}`];
  }
  return [502, `連不上 Yahoo Finance: ${err?.message || err}`];
}

export function createApi({ fetchImpl = fetch, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 300, ttlMs = 6 * HOUR, searchTtlMs = HOUR / 6, maxCache = 200 } = {}) {
  const cache = new Map(), inflight = new Map();
  let chain = Promise.resolve();

  /** 對 Yahoo 的請求一次一個,中間隔一小段時間(同時抓一個 8 檔的組合不會被限流) */
  const schedule = (fn) => {
    const p = chain.then(fn);
    chain = p.then(() => sleep(pauseMs), () => sleep(pauseMs));
    return p;
  };

  async function cached(key, ttl, produce) {
    const hit = cache.get(key);
    if (hit && now().getTime() - hit.at < ttl) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = schedule(produce).then((value) => {
      cache.set(key, { at: now().getTime(), value });
      if (cache.size > maxCache) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };

  /** 處理 /api/* 的請求;不是 /api 的網址回傳 false(交給靜態檔案) */
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    if (req.method !== 'GET') { send(res, 405, { error: '只支援 GET' }); return true; }
    if (!HOST_RE.test(req.headers.host || '')) { send(res, 403, { error: '不允許的 Host' }); return true; }
    if (req.headers['x-strategy-lab'] !== '1') { send(res, 403, { error: '缺少 X-Strategy-Lab 標頭' }); return true; }

    if (url.pathname === '/api/health') { send(res, 200, { ok: true, service: 'strategy-lab', version: 1 }); return true; }

    if (url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      // eslint-disable-next-line no-control-regex
      if (!q || q.length > 60 || /[\u0000-\u001f\u007f]/.test(q)) { send(res, 400, { error: '搜尋文字不能是空的,也不能超過 60 個字' }); return true; }
      if (/[^\u0000-\u007f]/.test(q)) { send(res, 422, { error: NON_ASCII_SEARCH }); return true; }            // Yahoo 的搜尋對中文一律回 400(實測),不必送出去
      try { send(res, 200, await cached(`s|${q.toLowerCase()}`, searchTtlMs, () => searchSymbols(q, { fetchImpl }))); } catch (err) {
        const [status, message] = err instanceof FetchError
          ? (err.status === 429 ? [503, 'Yahoo 暫時限流(請求太頻繁),等一兩分鐘再試。'] : [502, `搜尋失敗: ${err.message}。可以直接輸入代號(例如 2330.TW)再按 Enter。`])
          : [502, `連不上 Yahoo Finance: ${err?.message || err}`];
        send(res, status, { error: message });
      }
      return true;
    }

    if (url.pathname === '/api/prices') {
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase();
      if (!SYMBOL_RE.test(symbol)) { send(res, 400, { error: '代號格式不正確(只能用英數字與 ^ . = -,最長 20 字)' }); return true; }
      const y = Number(url.searchParams.get('years'));
      const years = Number.isFinite(y) && y >= 1 && y <= 40 ? y : 26;
      const key = `p|${symbol}|${years}`;
      if (url.searchParams.get('fresh') === '1') cache.delete(key);                  // 「重新下載」: 略過快取
      try { send(res, 200, await cached(key, ttlMs, () => loadSymbol(symbol, { years, now: now(), fetchImpl, sleep }))); } catch (err) {
        const [status, message] = explain(err, symbol);
        send(res, status, { error: message });
      }
      return true;
    }

    send(res, 404, { error: '沒有這個 API' });
    return true;
  }

  return { handle, cache };
}
