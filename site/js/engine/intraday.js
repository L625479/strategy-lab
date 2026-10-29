// 盤中 K 線驗證: 日線分不出「限價單成交」和「停利」誰先發生,用盤中 K 棒把先後順序解開。
//
// 規則的條件、限價距離、停利幅度仍然用日線(開盤決策框架)判斷,和當沖掃描完全一樣;
// 只有「這一天實際怎麼成交」改用當天的盤中 K 棒(每根的高、低,加上當天的開盤與收盤):
//   進場價 E = 當天開盤 × (1 ∓ 距離);市價進場成交在開盤,限價進場要等到某一根 K 棒的低點(放空是高點)
//   穿過 E 一個 bufferBps 才成交,成交在 E。第 j 根成交 → 停利價 T 要在「成交之後」才算數:
//     保守 = 第 j+1 根(含)以後的高/低點碰到 T(穿價 bufferBps)才算停利 — 成交那一根不算,因為同一根裡的先後仍分不出來
//     樂觀 = 第 j 根(含)以後 — 成交那一根也算(上界)
//   沒停利就收盤出場。市價進場兩種算法相同。每筆淨報酬 = 方向 × (出場價 / 進場價 - 1) - 2 × 單邊成本。
// 與使用者的 lab/daytrade.py(load_intraday / trades_intraday)與 run_daytrade.py(intraday)逐項對照過,見 tests-js/intraday_parity.test.js。

import { runRules } from './daytrade.js';

/**
 * 把盤中檔(intradayFromNpz 的輸出)對齊到日線面板。
 *   標的: 檔裡有 tickers 就用代號對,沒有就要求檔數一樣、順序相同(他的 build_intraday 就是這樣存的)
 *   日期: 只留下在日線日曆上的日子(其餘無法判斷條件,略過),column[k] = 面板第 k 檔在盤中檔的欄位(-1 = 沒有)
 */
export function alignIntraday(panel, intra) {
  let column;
  if (intra.tickers) {
    const at = new Map(intra.tickers.map((t, i) => [t, i]));
    column = Int32Array.from(panel.tickers, (t) => at.get(t) ?? -1);
  } else {
    if (intra.m !== panel.tickers.length) throw new Error(`盤中檔有 ${intra.m} 檔,日線面板有 ${panel.tickers.length} 檔。盤中檔沒有存代號,檔數與順序必須和日線面板一致`);
    column = Int32Array.from(panel.tickers, (_, i) => i);
  }
  const rowOf = new Map(panel.dates.map((d, i) => [d, i]));
  const keep = [], rows = [];
  intra.dates.forEach((d, f) => { const r = rowOf.get(d); if (r !== undefined) { keep.push(f); rows.push(r); } });
  if (!keep.length) throw new Error('盤中檔的日期與日線面板沒有任何交集');
  const rowToDay = new Int32Array(panel.dates.length).fill(-1);
  rows.forEach((r, d) => { rowToDay[r] = d; });
  return {
    intra, column, n: keep.length, nb: intra.nb, keep: Int32Array.from(keep), rows: Int32Array.from(rows), rowToDay,
    dates: keep.map((f) => intra.dates[f]), skippedDates: intra.dates.length - keep.length,
    matched: column.reduce((a, c) => a + (c >= 0 ? 1 : 0), 0),
  };
}

/**
 * 一檔標的的盤中資料,預先算成累積的高低點:
 *   lo / hi          到第 b 根(含)為止的最低 / 最高,尚無資料 = +Infinity / -Infinity
 *   loAfter / hiAfter 第 b 根(含)以後的最低 / 最高,多一格(b = nb)代表「之後沒有 K 棒」= +Infinity / -Infinity
 * 缺值(NaN)的 K 棒直接略過,和 numpy 的 fmin / fmax 相同。
 */
export function prepareTicker(a, col) {
  const { n, nb } = a, { m, H, L, O, C } = a.intra;
  const lo = new Float64Array(n * nb), hi = new Float64Array(n * nb);
  const loAfter = new Float64Array(n * (nb + 1)), hiAfter = new Float64Array(n * (nb + 1));
  const o = new Float64Array(n), c = new Float64Array(n);
  for (let d = 0; d < n; d++) {
    const f = a.keep[d];
    o[d] = O[f * m + col]; c[d] = C[f * m + col];
    let mn = Infinity, mx = -Infinity;
    for (let b = 0; b < nb; b++) {
      const i = (f * nb + b) * m + col;
      if (L[i] < mn) mn = L[i];
      if (H[i] > mx) mx = H[i];
      lo[d * nb + b] = mn; hi[d * nb + b] = mx;
    }
    let sl = Infinity, sh = -Infinity;
    const base = d * (nb + 1);
    loAfter[base + nb] = Infinity; hiAfter[base + nb] = -Infinity;
    for (let b = nb - 1; b >= 0; b--) {
      const i = (f * nb + b) * m + col;
      if (L[i] < sl) sl = L[i];
      if (H[i] > sh) sh = H[i];
      loAfter[base + b] = sl; hiAfter[base + b] = sh;
    }
  }
  return { n, nb, o, c, lo, hi, loAfter, hiAfter };
}

/**
 * 在 days(盤中日期軸上的索引)模擬一條規則,每筆成交呼叫 sink(day, netReturn)。
 * dist / tp 已經是盤中日期軸上的序列(null = 開盤市價 / 收盤出場)。
 */
export function simulateIntradayDays(prep, days, dist, tp, sideName, { optimistic = false, cost = 5e-4, buffer = 1e-3 }, sink) {
  const { nb, o, c, lo, hi, loAfter, hiAfter } = prep, s = sideName === 'short' ? -1 : 1;
  for (let q = 0; q < days.length; q++) {
    const d = days[q];
    let E = o[d], j = -1;                                   // j = 成交的那一根(-1 = 開盤市價)
    if (dist) {
      const dd = dist[d];
      if (!(dd >= 0)) continue;
      E = o[d] * (1 - s * dd);
      j = 0;
      const base = d * nb;
      if (s > 0) { const thr = E * (1 - buffer); while (j < nb && lo[base + j] > thr) j++; }
      else { const thr = E * (1 + buffer); while (j < nb && hi[base + j] < thr) j++; }
      if (j >= nb) continue;                                // 整天都沒有成交
    }
    let X = c[d];
    if (tp) {
      const t = tp[d];
      if (!(t >= 0)) continue;
      const T = E * (1 + s * t);
      const k = optimistic ? Math.max(j, 0) : j + 1;          // 最大 nb(= 補的那一格: 成交在最後一根,之後沒有 K 棒)
      const hit = s > 0 ? hiAfter[d * (nb + 1) + k] >= T * (1 + buffer) : loAfter[d * (nb + 1) + k] <= T * (1 - buffer);
      if (hit) X = T;
    }
    const r = s * (X / E - 1) - 2 * cost;
    if (Number.isFinite(r)) sink(d, r);
  }
}

/** runRules 用的盤中模式。日線的條件 / 距離 / 停利序列依 rows 搬到盤中日期軸上。 */
export function intradayMode(a) {
  return {
    nDays: a.n,
    forTicker(k) {
      const col = a.column[k];
      if (col < 0) return null;
      const prep = prepareTicker(a, col);
      return {
        days: (rows) => {
          const out = [];
          for (let q = 0; q < rows.length; q++) { const d = a.rowToDay[rows[q]]; if (d >= 0) out.push(d); }
          return Int32Array.from(out);
        },
        series: (s) => { const out = new Float64Array(a.n); for (let d = 0; d < a.n; d++) out[d] = s[a.rows[d]]; return out; },
        simulate: (days, dist, tp, side, opts, sink) => simulateIntradayDays(prep, days, dist, tp, side, opts, sink),
      };
    },
  };
}

/** 與 evaluateRules 相同的輸出形狀。cfg.segments 的 rows 是盤中日期軸(aligned.n 天)上的布林陣列。 */
export function evaluateIntraday(panel, aligned, compiled, cfg, onProgress = () => {}) {
  return runRules(panel, compiled, { daily: true, ...cfg }, intradayMode(aligned), onProgress);
}

// ---- 切分與驗收 -------------------------------------------------------------------

/** 他的程序: 60 分 K 的交易日對半切,前半 I1(選擇)、後半 I2(確認);天數是奇數時 I2 多一天。 */
export function halfSegments(n, { minTrades = 5 } = {}) {
  const half = n >> 1;
  return [
    { name: 'i1', rows: Array.from({ length: n }, (_, d) => d < half), minTrades },
    { name: 'i2', rows: Array.from({ length: n }, (_, d) => d >= half), minTrades },
  ];
}

/** 5 分 K: 所有交易日都算,個股最少 1 筆。 */
export function allDaysSegment(n, { minTrades = 1 } = {}) {
  return [{ name: 'all', rows: Array.from({ length: n }, () => true), minTrades }];
}

/** 確認階段要看的規則: 存活候選,加上 I1 機械決定的候選(通過 / a / b / c),去掉重複,順序同他的程式。 */
export function confirmKeys(live, candidates) {
  return [...new Set([...live, ...Object.values(candidates)])];
}

/** I1 樂觀上界仍然通過 D1 與 D2(勝率與平均報酬)= 存活候選。個股達標(D3)不在這一關。 */
export function isLive(optStats, thr) {
  return optStats.win > thr.winThreshold && optStats.mean >= thr.meanThreshold;
}

/**
 * 最終合格要通過的八項檢查,回傳沒通過的那幾項(空陣列 = 合格):
 *   live      存活候選(I1 樂觀上界過 D1 與 D2)
 *   i2.D1 / i2.D2 / i2.D3     I2 保守過 D1–D3
 *   x2.D1 / x2.D2             I2 兩倍成本過 D1 與 D2(個股達標不要求)
 *   m5.D1 / m5.D2             5 分 K 保守過 D1 與 D2(個股達標不要求)
 * c = { live, i2, i2x2, m5 }(各是 stats)
 */
export function failedChecks(c, thr) {
  const p = (s) => ({ D1: s.win > thr.winThreshold, D2: s.mean >= thr.meanThreshold, D3: s.stockPass > thr.passShare });
  const i2 = p(c.i2), x2 = p(c.i2x2), m5 = p(c.m5);
  const checks = [['live', Boolean(c.live)], ['i2.D1', i2.D1], ['i2.D2', i2.D2], ['i2.D3', i2.D3], ['x2.D1', x2.D1], ['x2.D2', x2.D2], ['m5.D1', m5.D1], ['m5.D2', m5.D2]];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

export const isQualified = (c, thr) => failedChecks(c, thr).length === 0;
