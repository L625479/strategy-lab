// 價格資料: 預先抓好的 JSON(欄位式陣列)與使用者上傳的 CSV,統一成 bars 結構:
//   { d: string[] ('YYYY-MM-DD'), o, h, l, c, v: Float64Array, n }

const f64 = (arr) => Float64Array.from(arr, (x) => (x === null || x === undefined ? NaN : Number(x)));

export function toBars(json) {
  const { d, o, h, l, c, v } = json || {};
  if (![d, o, h, l, c].every(Array.isArray) || ![o, h, l, c].every((a) => a.length === d.length)) {
    throw new Error('價格檔格式不正確(需要等長的 d/o/h/l/c 陣列)');
  }
  return { d: d.slice(), o: f64(o), h: f64(h), l: f64(l), c: f64(c), v: Array.isArray(v) && v.length === d.length ? f64(v) : new Float64Array(d.length), n: d.length };
}

/** 開收價「完全相同」但有振幅的 K 棒佔比: 偏高通常代表資料源的收盤價是過期的佔位值 */
export function staleCloseShare(bars) {
  let stale = 0;
  for (let i = 0; i < bars.n; i++) if (Math.abs(bars.o[i] - bars.c[i]) < 1e-9 && bars.h[i] > bars.l[i]) stale++;
  return bars.n ? stale / bars.n : 0;
}

const isoFromUnix = (x) => new Date((Math.abs(x) > 1e11 ? x : x * 1000)).toISOString().slice(0, 10);

function parseDateCell(cell) {
  const s = String(cell).trim().replace(/^"|"$/g, '');
  if (/^\d{9,13}$/.test(s)) return isoFromUnix(Number(s));
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const HEADERS = {
  time: ['time', 'date', 'datetime', 'timestamp', 'day', '日期', '時間'],
  open: ['open', 'o', '開盤', '開盤價'],
  high: ['high', 'h', '最高', '最高價'],
  low: ['low', 'l', '最低', '最低價'],
  close: ['close', 'c', '收盤', '收盤價'],
  adj: ['adj close', 'adj_close', 'adjclose', 'adjusted close', '調整後收盤價'],
  volume: ['volume', 'vol', 'v', '成交量'],
};

/**
 * 解析 CSV(TradingView 匯出、Yahoo 下載或一般 OHLCV)。
 * 回傳 { bars, issues: {skipped, repaired, duplicates, adjusted}, staleShare }
 */
export function parseCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((x) => x.trim());
  if (lines.length < 2) throw new Error('CSV 是空的或只有標題列');
  const delim = [',', ';', '\t'].map((d) => [d, lines[0].split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const header = lines[0].split(delim).map((x) => x.trim().replace(/^"|"$/g, '').toLowerCase());
  const col = (names) => header.findIndex((h) => names.includes(h));
  const idx = Object.fromEntries(Object.entries(HEADERS).map(([k, names]) => [k, col(names)]));
  const missing = ['time', 'open', 'high', 'low', 'close'].filter((k) => idx[k] < 0);
  if (missing.length) throw new Error(`CSV 缺少欄位: ${missing.join('、')}(需要 time/date、open、high、low、close)`);

  const issues = { skipped: 0, repaired: 0, duplicates: 0, adjusted: idx.adj >= 0 };
  const rows = new Map();
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split(delim);
    const date = parseDateCell(cells[idx.time] ?? '');
    let o = Number(cells[idx.open]), h = Number(cells[idx.high]), l = Number(cells[idx.low]), c = Number(cells[idx.close]);
    const v = idx.volume >= 0 ? Number(cells[idx.volume]) : 0;
    if (!date || ![o, h, l, c].every((x) => Number.isFinite(x) && x > 0)) { issues.skipped++; continue; }
    if (idx.adj >= 0) {
      const adj = Number(cells[idx.adj]);
      if (Number.isFinite(adj) && adj > 0) { const k = adj / c; o *= k; h *= k; l *= k; c = adj; }
    }
    const hi = Math.max(o, h, l, c), lo = Math.min(o, h, l, c);
    if (hi !== h || lo !== l) { issues.repaired++; h = hi; l = lo; }
    if (rows.has(date)) issues.duplicates++;
    rows.set(date, [o, h, l, c, Number.isFinite(v) ? v : 0]);
  }
  const dates = [...rows.keys()].sort();
  if (dates.length < 30) throw new Error(`有效資料只有 ${dates.length} 列,至少需要 30 列才能回測`);
  const bars = {
    d: dates, n: dates.length,
    o: Float64Array.from(dates, (k) => rows.get(k)[0]), h: Float64Array.from(dates, (k) => rows.get(k)[1]),
    l: Float64Array.from(dates, (k) => rows.get(k)[2]), c: Float64Array.from(dates, (k) => rows.get(k)[3]),
    v: Float64Array.from(dates, (k) => rows.get(k)[4]),
  };
  return { bars, issues, staleShare: staleCloseShare(bars) };
}

/** 畫面上用的簡短標的 id: 只留字母數字與 . - _ */
export const cleanId = (s) => String(s).trim().replace(/[^A-Za-z0-9._\-一-鿿]/g, '').slice(0, 24);

/**
 * 價格檔的檔名。靜態網站伺服器會把網址裡的 %XX 先解碼再找檔案,所以檔名本身不能含需要編碼的字元
 * (例如 ^VIX、CL=F);其他字元一律換成 _ 加兩位十六進位(連底線本身也是,所以不會撞名)。
 * tools/fetch_prices.py 的 price_filename() 必須和這裡一致(兩邊的測試用同一張對照表)。
 */
export const priceFileName = (id) => String(id).replace(/[^A-Za-z0-9.-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
