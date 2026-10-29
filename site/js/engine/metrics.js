// 績效指標。日期一律是 'YYYY-MM-DD' 字串;權益是 Float64Array。
// 年化係數由資料本身估計(筆數 / 年數),所以股票(約 252)與加密貨幣(365)混在同一個組合也成立。

const DAY_MS = 86400000;
const toMs = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);
export const yearsBetween = (a, b) => (toMs(b) - toMs(a)) / (365.25 * DAY_MS);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** 回撤序列(<= 0 的小數):每個時點相對歷史高點 */
export function drawdownSeries(equity, initial) {
  const out = new Float64Array(equity.length);
  let peak = initial;
  for (let i = 0; i < equity.length; i++) {
    peak = Math.max(peak, equity[i]);
    out[i] = equity[i] / peak - 1;
  }
  return out;
}

/**
 * @param {string[]} dates 與 equity 等長
 * @param {Float64Array} equity 每日收盤權益
 * @param {number} initial 起始資金
 */
export function equityMetrics(dates, equity, initial, { rf = 0 } = {}) {
  const n = equity.length;
  const finalEquity = n ? equity[n - 1] : initial;
  const out = {
    finalEquity, totalReturn: finalEquity / initial - 1, years: 0, ppy: 0, cagr: NaN, vol: NaN,
    sharpe: NaN, sortino: NaN, maxDrawdown: 0, maxDdDays: 0, calmar: NaN, bestDay: NaN, worstDay: NaN,
  };
  if (n < 2) return out;

  const dd = drawdownSeries(equity, initial);
  out.maxDrawdown = Math.min(0, ...dd);
  // 最長的水下期間(從創高到再次創高,尚未恢復則算到結束)
  let peakIdx = -1, longest = 0, peakVal = initial;
  for (let i = 0; i < n; i++) {
    if (equity[i] >= peakVal) { peakVal = equity[i]; peakIdx = i; } else {
      const from = peakIdx < 0 ? dates[0] : dates[peakIdx];
      longest = Math.max(longest, daysBetween(from, dates[i]));
    }
  }
  out.maxDdDays = longest;

  out.years = yearsBetween(dates[0], dates[n - 1]);
  out.ppy = out.years > 0 ? (n - 1) / out.years : 0;
  out.cagr = out.years > 0 && finalEquity > 0 ? (finalEquity / initial) ** (1 / out.years) - 1 : NaN;

  const rets = [];
  for (let i = 1; i < n; i++) rets.push(equity[i] / equity[i - 1] - 1);
  if (out.ppy > 0) {
    const rfPer = rf / out.ppy;
    const sd = std(rets);
    out.vol = sd * Math.sqrt(out.ppy);
    out.sharpe = sd > 0 ? ((mean(rets) - rfPer) / sd) * Math.sqrt(out.ppy) : NaN;
    const downside = Math.sqrt(mean(rets.map((r) => Math.min(r - rfPer, 0) ** 2)));
    out.sortino = downside > 0 ? ((mean(rets) - rfPer) / downside) * Math.sqrt(out.ppy) : NaN;
  }
  out.calmar = out.maxDrawdown < 0 && Number.isFinite(out.cagr) ? out.cagr / Math.abs(out.maxDrawdown) : NaN;
  out.bestDay = Math.max(...rets);
  out.worstDay = Math.min(...rets);
  return out;
}

export function tradeStats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.pnl, 0);
  return {
    n,
    winRate: n ? wins.length / n : NaN,
    avgWin: wins.length ? grossProfit / wins.length : NaN,
    avgLoss: losses.length ? -grossLoss / losses.length : NaN,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : NaN),
    expectancy: n ? trades.reduce((a, t) => a + t.pnl, 0) / n : NaN,
    avgRetPct: n ? mean(trades.map((t) => t.retPct)) : NaN,
    avgBars: n ? mean(trades.map((t) => t.bars)) : NaN,
    bestPct: n ? Math.max(...trades.map((t) => t.retPct)) : NaN,
    worstPct: n ? Math.min(...trades.map((t) => t.retPct)) : NaN,
    grossProfit, grossLoss,
    longs: trades.filter((t) => t.dir === 'long').length,
    shorts: trades.filter((t) => t.dir === 'short').length,
    byReason: trades.reduce((acc, t) => { acc[t.reason] = (acc[t.reason] || 0) + 1; return acc; }, {}),
  };
}

/** 月報酬: 以每月最後一個交易日的權益計算;第一個月以起始資金為基準 */
export function monthlyReturns(dates, equity, initial) {
  const out = [];
  let prev = initial, curKey = null, curEq = initial;
  for (let i = 0; i < dates.length; i++) {
    const key = dates[i].slice(0, 7);
    if (curKey !== null && key !== curKey) {
      out.push({ year: +curKey.slice(0, 4), month: +curKey.slice(5, 7), ret: curEq / prev - 1 });
      prev = curEq;
    }
    curKey = key; curEq = equity[i];
  }
  if (curKey !== null) out.push({ year: +curKey.slice(0, 4), month: +curKey.slice(5, 7), ret: curEq / prev - 1 });
  return out;
}

/** 相關係數矩陣(用兩兩皆有值的日報酬) */
export function correlationMatrix(seriesList) {
  const rets = seriesList.map((s) => {
    const r = new Float64Array(s.length - 1);
    for (let i = 1; i < s.length; i++) r[i - 1] = s[i] / s[i - 1] - 1;
    return r;
  });
  return rets.map((a) => rets.map((b) => {
    const m = Math.min(a.length, b.length);
    if (m < 3) return NaN;
    const x = Array.from(a.subarray(0, m)), y = Array.from(b.subarray(0, m));
    const mx = mean(x), my = mean(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < m; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  }));
}
