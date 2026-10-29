// 目標權重策略的帳戶模擬: 收盤產生目標權重、隔天開盤依目標調整,並逐日計入融資利息、閒置現金利息、借券費與交易成本。
//
// 帳戶慣例(全部寫在這裡,因為每一條都會影響績效):
//   - 訊號: 第 t 天收盤的目標權重,在第 t+1 天開盤成交(沒有未來函數)。起始日 > 第一根時,起始日開盤依「前一天收盤」的訊號成交。
//   - 權重 = 部位市值 ÷ 淨值(多單為正、空單為負)。目標權重先把 NaN 當 0、不能放空時夾到 >= 0、總曝險(各標的絕對值加總)超過上限時等比例縮小。
//   - 再平衡帶: 某標的「開盤時的實際權重」與目標差距超過 band 才調整(調整到目標,一次成交算一筆);帶內的偏離不動。
//   - 成本: 成交金額 × 單邊 bps。沒有滑價以外的其他假設(滑價請併入單邊成本)。
//   - 利息: 每根 K 棒結算「與前一根相隔的日曆天數 ÷ 365」,依「前一根收盤時的餘額」計算,當根開盤的成交從下一根開始計息。
//       閒置自有現金 = max(0, 淨值 − 多單市值),賺利率 r;
//       融資 = max(0, 多單市值 − 淨值),付 r + 融資利差;
//       空單市值 × 借券費(年率);放空所得不計息、也不拿來抵融資(視為擔保品)。
//     r 取前一根收盤時的利率(固定值或利率序列 ÷ 100)。
//   - 淨值 <= 0 就視為爆倉: 部位清空、淨值歸零並維持到結束(不模擬追繳保證金與強制平倉的細節)。
//   - 缺價: 當天沒有開盤價的標的當天不調整;估值用最近一次有效的收盤價。

import { daysBetween, drawdownSeries, equityMetrics, monthlyReturns } from './metrics.js';
import { evaluateWeights, rateSeries } from './weights.js';

const sumOf = (a) => { let t = 0; for (const x of a) t += x; return t; };
const totalsOf = (r) => ({ interest: sumOf(r.interest), financing: sumOf(r.financing), borrowFee: sumOf(r.borrowFee), costs: sumOf(r.tradeCost), notional: r.fills.reduce((a, f) => a + f.notional, 0) });

/** 把一次從資料開頭跑完的結果切成「從 offset 起」的一段,並把金額換算成「這段期間開始時有 capital」的比例 */
function sliceRun(r, offset, scale) {
  const cut = (a, mul = 1) => (mul === 1 ? a.slice(offset) : a.slice(offset).map((x) => x * mul));
  const out = {
    dates: r.dates.slice(offset), equity: cut(r.equity, scale), gross: cut(r.gross), net: cut(r.net), borrowed: cut(r.borrowed),
    exposure: r.exposure.map((a) => cut(a)), shares: r.shares.map((a) => cut(a, scale)),
    accrual: cut(r.accrual, scale), interest: cut(r.interest, scale), financing: cut(r.financing, scale), borrowFee: cut(r.borrowFee, scale), tradeCost: cut(r.tradeCost, scale),
    startIdx: r.startIdx + offset,
    fills: r.fills.filter((f) => f.idx >= r.startIdx + offset).map((f) => ({ ...f, shares: f.shares * scale, notional: f.notional * scale, cost: f.cost * scale })),
    ruined: r.ruined, totals: null,
  };
  out.totals = totalsOf(out);
  return out;
}

const clampTargets = (raw, { allowShort, maxGross }) => {
  const t = raw.map((x) => (Number.isFinite(x) ? (allowShort ? x : Math.max(0, x)) : 0));
  const gross = t.reduce((a, x) => a + Math.abs(x), 0);
  return gross > maxGross ? t.map((x) => (x * maxGross) / gross) : t;
};

/**
 * @param {object} a
 *   dates: string[]  tradables: [{name,o,h,l,c}](與 dates 等長,缺值 NaN)  weights: Float64Array[](每個標的的目標權重,小數)
 *   rate: Float64Array(年利率,小數)  capital  startIdx  endIdx
 *   band(小數)  maxGross  allowShort  sideBps  borrowFeePct  spreadPct
 */
export function runTargetWeights({ dates, tradables, weights, rate, capital, startIdx, endIdx, band, maxGross, allowShort, sideBps, borrowFeePct, spreadPct }) {
  if (!(capital > 0)) throw new Error('初始資金必須大於 0');
  if (!(startIdx <= endIdx)) throw new Error('回測區間內沒有資料');
  const n = endIdx - startIdx + 1, m = tradables.length;
  const cost = sideBps / 1e4, fee = borrowFeePct / 100, spread = spreadPct / 100;
  const out = {
    startIdx, dates: dates.slice(startIdx, endIdx + 1), equity: new Float64Array(n), gross: new Float64Array(n), net: new Float64Array(n), borrowed: new Float64Array(n),
    exposure: tradables.map(() => new Float64Array(n)), shares: tradables.map(() => new Float64Array(n)),
    accrual: new Float64Array(n), interest: new Float64Array(n), financing: new Float64Array(n), borrowFee: new Float64Array(n), tradeCost: new Float64Array(n), fills: [],
    totals: null, ruined: false,
  };

  let cash = capital, ruined = false;
  const sh = new Float64Array(m), last = new Float64Array(m).fill(NaN);
  let Eprev = capital, Lprev = 0, Sprev = 0;

  for (let i = startIdx; i <= endIdx; i++) {
    const k = i - startIdx;
    // 1) 利息: 依前一根收盤的餘額
    if (i > startIdx) {
      const dt = daysBetween(dates[i - 1], dates[i]) / 365, r = rate[i - 1] || 0;
      const interest = Math.max(0, Eprev - Lprev) * r * dt, financing = Math.max(0, Lprev - Eprev) * (r + spread) * dt, borrowFee = Sprev * fee * dt;
      cash += interest - financing - borrowFee;
      out.accrual[k] = interest - financing - borrowFee;
      out.interest[k] = interest; out.financing[k] = financing; out.borrowFee[k] = borrowFee;
    }

    // 2) 開盤: 依前一天收盤的目標權重調整
    if (!ruined && i > 0) {
      const price = (j) => (Number.isFinite(tradables[j].o[i]) ? tradables[j].o[i] : last[j]);
      let Eopen = cash;
      for (let j = 0; j < m; j++) if (sh[j] !== 0) Eopen += sh[j] * price(j);
      if (Eopen <= 0) {
        ruined = true; out.ruined = true;
        sh.fill(0); cash = 0;
      } else {
        const target = clampTargets(weights.map((w) => w[i - 1]), { allowShort, maxGross });
        for (let j = 0; j < m; j++) {
          const o = tradables[j].o[i];
          if (!Number.isFinite(o) || !(o > 0)) continue;
          const cur = (sh[j] * o) / Eopen;
          if (Math.abs(cur - target[j]) <= band) continue;
          const newShares = (target[j] * Eopen) / o, delta = newShares - sh[j];
          if (delta === 0) continue;
          const notional = Math.abs(delta) * o, c = notional * cost;
          cash -= delta * o + c;
          sh[j] = newShares;
          out.tradeCost[k] += c;
          out.fills.push({ idx: i, date: dates[i], series: tradables[j].name, shares: delta, price: o, notional, cost: c, fromWeight: cur, toWeight: target[j] });
        }
      }
    }

    // 3) 收盤: 估值
    let L = 0, S = 0, P = 0;
    const val = new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const c = tradables[j].c[i];
      if (Number.isFinite(c)) last[j] = c;
      val[j] = sh[j] !== 0 ? sh[j] * last[j] : 0;
      P += val[j];
      if (val[j] > 0) L += val[j]; else S -= val[j];
    }
    let E = cash + P;
    if (!ruined && E <= 0) { ruined = true; out.ruined = true; sh.fill(0); cash = 0; E = 0; L = 0; S = 0; val.fill(0); }
    out.equity[k] = E;
    if (E > 0) {
      out.gross[k] = (L + S) / E; out.net[k] = (L - S) / E; out.borrowed[k] = Math.max(0, L - E) / E;
      for (let j = 0; j < m; j++) { out.exposure[j][k] = val[j] / E; }
    }
    for (let j = 0; j < m; j++) out.shares[j][k] = sh[j];
    Eprev = E; Lprev = L; Sprev = S;
  }
  out.totals = totalsOf(out);
  return out;
}

const firstIdxOnOrAfter = (dates, d) => { if (!d) return 0; const i = dates.findIndex((x) => x >= d); return i; };
const lastIdxOnOrBefore = (dates, d) => { if (!d) return dates.length - 1; for (let i = dates.length - 1; i >= 0; i--) if (dates[i] <= d) return i; return -1; };

/** 買入持有(第一天開盤買進、不動): capital × close / open[start],缺值沿用前值 */
function buyAndHold(arrs, startIdx, endIdx, capital) {
  let i0 = startIdx;
  while (i0 <= endIdx && !Number.isFinite(arrs.o[i0]) && !Number.isFinite(arrs.c[i0])) i0++;
  const base = Number.isFinite(arrs.o[i0]) ? arrs.o[i0] : arrs.c[i0];
  const out = new Float64Array(endIdx - startIdx + 1).fill(capital);
  let lastC = base;
  for (let i = startIdx; i <= endIdx; i++) {
    if (i >= i0 && Number.isFinite(arrs.c[i])) lastC = arrs.c[i];
    out[i - startIdx] = i < i0 ? capital : (capital * lastC) / base;
  }
  return out;
}

/**
 * 完整流程: 對齊資料 → 求目標權重 → 帳戶模擬 → 績效。
 * @param compiled compileWeights().compiled   @param data buildWeightsData() 的結果
 * @param opts { capital, start, end, benchmark: 序列名稱 | '', carryIn }
 *   carryIn(預設 true): 策略從資料開頭就開始跑,只是績效從 start 起算(部位延續下來,和「凍結規則在 holdout 期間的表現」同一個意思);
 *   false: 從 start 當天空手開始(指標仍用 start 之前的歷史預熱)。
 */
export function runWeights(compiled, data, { capital = 100000, start = '', end = '', benchmark = '', carryIn = true } = {}) {
  const s = compiled.strategy;
  const { weights } = evaluateWeights(compiled, data);
  const warm = s.warmupBars;
  for (const w of weights) for (let i = 0; i < Math.min(warm, w.length); i++) w[i] = 0;
  const rate = rateSeries(compiled, data);
  const startIdx = firstIdxOnOrAfter(data.dates, start), endIdx = lastIdxOnOrBefore(data.dates, end);
  if (startIdx < 0 || endIdx < startIdx) throw new Error('所選期間內沒有資料');
  const runStart = carryIn ? 0 : startIdx;
  const full = runTargetWeights({
    dates: data.dates, tradables: data.tradables, weights, rate, capital, startIdx: runStart, endIdx,
    band: s.band / 100, maxGross: s.maxGross, allowShort: s.allowShort, sideBps: s.costs.sideBps, borrowFeePct: s.costs.borrowFeePct, spreadPct: s.costs.financingSpreadPct,
  });
  let run = full;
  if (runStart < startIdx) {
    const before = full.equity[startIdx - runStart - 1];
    run = sliceRun(full, startIdx - runStart, before > 0 ? capital / before : 1);
  }
  const dates = run.dates;
  const prim = data.series[compiled.primary];
  const buyHold = buyAndHold(prim, startIdx, endIdx, capital);
  const bench = benchmark && data.series[benchmark] ? { id: benchmark, equity: buyAndHold(data.series[benchmark], startIdx, endIdx, capital) } : null;
  const years = (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / (365.25 * 86400000);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const BORROW_FLAG = 0.01;                                                  // 多單超過淨值 1% 以上才算「使用融資」(滿倉時成本造成的微小負現金不算)
  const levered = run.borrowed.filter((x) => x > BORROW_FLAG).length;
  const warnings = Object.keys(data.dropped || {}).length ? [`${Object.entries(data.dropped).map(([id, c]) => `${id}(${c} 根)`).join('、')} 的 K 棒不在共同交易日曆上(例如週末),已略過`] : [];
  if (run.ruined) warnings.push('淨值在回測中歸零(爆倉),之後維持 0');
  return {
    capital, dates, equity: run.equity, buyHold, bench, run, warnings,
    metrics: equityMetrics(dates, run.equity, capital), buyHoldMetrics: equityMetrics(dates, buyHold, capital),
    benchMetrics: bench ? equityMetrics(dates, bench.equity, capital) : null,
    drawdown: drawdownSeries(run.equity, capital), buyHoldDrawdown: drawdownSeries(buyHold, capital),
    monthly: monthlyReturns(dates, run.equity, capital),
    account: {
      avgGross: avg(run.gross), avgNet: avg(run.net), maxGross: Math.max(...run.gross), shareLevered: levered / run.borrowed.length,
      avgBorrowedWhenLevered: levered ? run.borrowed.filter((x) => x > BORROW_FLAG).reduce((a, b) => a + b, 0) / levered : 0,
      fills: run.fills.length, turnoverPerYear: years > 0 ? run.totals.notional / avg(Array.from(run.equity)) / years : NaN,
      interest: run.totals.interest, financing: run.totals.financing, borrowFee: run.totals.borrowFee, costs: run.totals.costs,
      startIdx, endIdx,
    },
  };
}
