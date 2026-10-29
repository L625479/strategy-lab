// 技術指標。序列一律是 Float64Array,缺值用 NaN。語意對齊 TradingView Pine v5 的 ta.*。

export const makeSeries = (n, fill = NaN) => new Float64Array(n).fill(fill);

/** 把純量展開成序列(讓 crossover(close, 100) 這類寫法可行) */
export function toSeries(x, n) {
  return typeof x === 'number' ? makeSeries(n, x) : x;
}

export function sma(src, length) {
  const n = Math.floor(length), out = makeSeries(src.length);
  if (!(n >= 1)) return out;
  for (let i = n - 1; i < src.length; i++) {
    let sum = 0, ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      if (Number.isNaN(src[k])) { ok = false; break; }
      sum += src[k];
    }
    if (ok) out[i] = sum / n;
  }
  return out;
}

/** Pine 的 ta.ema: 從第一個有效值起遞迴,沒有 SMA seed */
export function ema(src, length) {
  const n = Math.floor(length), out = makeSeries(src.length);
  if (!(n >= 1)) return out;
  const alpha = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (Number.isNaN(v)) { out[i] = NaN; continue; }
    prev = Number.isNaN(prev) ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

/** Wilder 平滑(Pine ta.rma): 前 n 個連續有效值的平均當 seed,之後 alpha = 1/n */
export function rma(src, length) {
  const n = Math.floor(length), out = makeSeries(src.length);
  if (!(n >= 1)) return out;
  const alpha = 1 / n;
  let prev = NaN;
  for (let i = 0; i < src.length; i++) {
    if (Number.isNaN(prev)) {
      if (i >= n - 1) {
        let sum = 0, ok = true;
        for (let k = i - n + 1; k <= i; k++) {
          if (Number.isNaN(src[k])) { ok = false; break; }
          sum += src[k];
        }
        if (ok) { prev = sum / n; out[i] = prev; }
      }
    } else if (!Number.isNaN(src[i])) {
      prev = alpha * src[i] + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

export function change(src, length = 1) {
  const k = Math.floor(length), out = makeSeries(src.length);
  for (let i = k; i < src.length; i++) out[i] = src[i] - src[i - k];
  return out;
}

export function shift(src, length = 1) {
  const k = Math.floor(length), out = makeSeries(src.length);
  if (k < 0) return out; // 不允許看未來
  for (let i = k; i < src.length; i++) out[i] = src[i - k];
  return out;
}

export function rsi(src, length) {
  const n = src.length, up = makeSeries(n), down = makeSeries(n);
  for (let i = 1; i < n; i++) {
    const d = src[i] - src[i - 1];
    up[i] = d > 0 ? d : (Number.isNaN(d) ? NaN : 0);
    down[i] = d < 0 ? -d : (Number.isNaN(d) ? NaN : 0);
  }
  const u = rma(up, length), d = rma(down, length), out = makeSeries(n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(u[i]) || Number.isNaN(d[i])) continue;
    // Pine: down == 0 ? 100 : up == 0 ? 0 : 100 - 100 / (1 + up / down)
    out[i] = d[i] === 0 ? 100 : (u[i] === 0 ? 0 : 100 - 100 / (1 + u[i] / d[i]));
  }
  return out;
}

export function trueRange(high, low, close) {
  const n = high.length, out = makeSeries(n);
  for (let i = 0; i < n; i++) {
    const hl = high[i] - low[i];
    out[i] = i === 0 ? hl : Math.max(hl, Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  return out;
}

export const atr = (high, low, close, length) => rma(trueRange(high, low, close), length);

function rolling(src, length, fn) {
  const n = Math.floor(length), out = makeSeries(src.length);
  if (!(n >= 1)) return out;
  for (let i = n - 1; i < src.length; i++) {
    const w = src.subarray(i - n + 1, i + 1);
    if (w.some(Number.isNaN)) continue;
    out[i] = fn(w);
  }
  return out;
}

export const highest = (src, length) => rolling(src, length, (w) => Math.max(...w));
export const lowest = (src, length) => rolling(src, length, (w) => Math.min(...w));

/** 母體標準差(同 Pine) */
export const stdev = (src, length) => rolling(src, length, (w) => {
  const m = w.reduce((a, b) => a + b, 0) / w.length;
  return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
});

export function crossover(a, b) {
  const n = a.length, out = makeSeries(n, 0);
  for (let i = 1; i < n; i++) out[i] = a[i] > b[i] && a[i - 1] <= b[i - 1] ? 1 : 0;
  return out;
}

export function crossunder(a, b) {
  const n = a.length, out = makeSeries(n, 0);
  for (let i = 1; i < n; i++) out[i] = a[i] < b[i] && a[i - 1] >= b[i - 1] ? 1 : 0;
  return out;
}

export const roc = (src, length) => {
  const prev = shift(src, length), out = makeSeries(src.length);
  for (let i = 0; i < src.length; i++) out[i] = (src[i] / prev[i] - 1) * 100;
  return out;
};

export function zscore(src, length) {
  const m = sma(src, length), s = stdev(src, length), out = makeSeries(src.length);
  for (let i = 0; i < src.length; i++) out[i] = s[i] > 0 ? (src[i] - m[i]) / s[i] : NaN;
  return out;
}

export function macd(src, fast, slow) {
  const f = ema(src, fast), s = ema(src, slow), out = makeSeries(src.length);
  for (let i = 0; i < src.length; i++) out[i] = f[i] - s[i];
  return out;
}

export const macdSignal = (src, fast, slow, signal) => ema(macd(src, fast, slow), signal);

export function bbUpper(src, length, mult) {
  const m = sma(src, length), s = stdev(src, length), out = makeSeries(src.length);
  for (let i = 0; i < src.length; i++) out[i] = m[i] + mult * s[i];
  return out;
}

export function bbLower(src, length, mult) {
  const m = sma(src, length), s = stdev(src, length), out = makeSeries(src.length);
  for (let i = 0; i < src.length; i++) out[i] = m[i] - mult * s[i];
  return out;
}

const binary = (a, b, fn) => {
  const n = (typeof a === 'number' ? b : a).length, out = makeSeries(n);
  for (let i = 0; i < n; i++) out[i] = fn(typeof a === 'number' ? a : a[i], typeof b === 'number' ? b : b[i]);
  return out;
};

/**
 * 規則語法可呼叫的函式表。每個函式: { fn, min, max, doc }。
 * atr() 需要 OHLC,所以用閉包綁定當前標的的資料。
 */
export function makeFunctions(bars) {
  const n = bars.c.length;
  const S = (x) => toSeries(x, n);
  // series: 'first' 只有第 1 個參數可以是序列(其餘必須是數字); 'none' 全是數字; 'all' 不限
  const def = (min, max, doc, fn, series = 'first') => ({ min, max, doc, fn, series });
  const two = (f) => (a, b) => f(S(a), S(b));
  return {
    sma: def(2, 2, 'sma(來源, 週期) 簡單移動平均', (s, k) => sma(S(s), k)),
    ema: def(2, 2, 'ema(來源, 週期) 指數移動平均', (s, k) => ema(S(s), k)),
    rma: def(2, 2, 'rma(來源, 週期) Wilder 平滑', (s, k) => rma(S(s), k)),
    rsi: def(2, 2, 'rsi(來源, 週期) 相對強弱指標 (0~100)', (s, k) => rsi(S(s), k)),
    atr: def(1, 1, 'atr(週期) 平均真實波幅(價格單位)', (k) => atr(bars.h, bars.l, bars.c, k), 'none'),
    tr: def(0, 0, 'tr() 每根的真實波幅(價格單位);sma(tr(), 14) 是簡單平均版的 ATR', () => trueRange(bars.h, bars.l, bars.c), 'none'),
    highest: def(2, 2, 'highest(來源, 週期) 區間最高', (s, k) => highest(S(s), k)),
    lowest: def(2, 2, 'lowest(來源, 週期) 區間最低', (s, k) => lowest(S(s), k)),
    stdev: def(2, 2, 'stdev(來源, 週期) 標準差', (s, k) => stdev(S(s), k)),
    change: def(1, 2, 'change(來源[, 期數]) 與前 N 根的差', (s, k = 1) => change(S(s), k)),
    shift: def(1, 2, 'shift(來源[, 期數]) 取前 N 根的值(也可寫 close[1])', (s, k = 1) => shift(S(s), k)),
    roc: def(2, 2, 'roc(來源, 週期) 變動率 %', (s, k) => roc(S(s), k)),
    zscore: def(2, 2, 'zscore(來源, 週期) 標準化分數', (s, k) => zscore(S(s), k)),
    macd: def(3, 3, 'macd(來源, 快, 慢) MACD 線', (s, f, sl) => macd(S(s), f, sl)),
    macd_signal: def(4, 4, 'macd_signal(來源, 快, 慢, 訊號) MACD 訊號線', (s, f, sl, sg) => macdSignal(S(s), f, sl, sg)),
    bb_upper: def(3, 3, 'bb_upper(來源, 週期, 倍數) 布林上軌', (s, k, m) => bbUpper(S(s), k, m)),
    bb_lower: def(3, 3, 'bb_lower(來源, 週期, 倍數) 布林下軌', (s, k, m) => bbLower(S(s), k, m)),
    crossover: def(2, 2, 'crossover(a, b) a 由下往上穿越 b', two(crossover), 'all'),
    crossunder: def(2, 2, 'crossunder(a, b) a 由上往下穿越 b', two(crossunder), 'all'),
    cross_above: def(2, 2, 'cross_above(a, b) 同 crossover', two(crossover), 'all'),
    cross_below: def(2, 2, 'cross_below(a, b) 同 crossunder', two(crossunder), 'all'),
    abs: def(1, 1, 'abs(x) 絕對值', (x) => (typeof x === 'number' ? Math.abs(x) : x.map(Math.abs)), 'all'),
    max: def(2, 2, 'max(a, b) 取大', (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.max(a, b) : binary(a, b, Math.max)), 'all'),
    min: def(2, 2, 'min(a, b) 取小', (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.min(a, b) : binary(a, b, Math.min)), 'all'),
  };
}

/** 規則裡可直接使用的內建序列名稱 */
export const BUILTIN_SERIES = {
  open: '開盤價', high: '最高價', low: '最低價', close: '收盤價', volume: '成交量',
  hl2: '(最高+最低)/2', hlc3: '(最高+最低+收盤)/3',
};
