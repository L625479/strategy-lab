// 單一標的回測: 逐根 K 棒推進,訊號在收盤確認、下一根開盤成交(沒有未來函數)。
//
// 成交假設:
// - 進出場市價單: 下一根開盤價,加上不利方向的滑價與手續費(bps)
// - 止損/止盈用 K 棒 high/low 判斷;同一根兩者都碰到時保守地取止損
// - 開盤跳空越過止損/止盈: 以開盤價成交(止損吃到跳空損失,止盈得到更好的價格)
// - 止損視為停損市價單(含滑價);止盈視為限價單(不含滑價)
// - 止損/止盈的距離以「成交價」的百分比計算
// - 每個標的同時最多一個部位;回測結束時仍持有的部位不強制平倉,以收盤價計入權益

/**
 * @param {{ bars: {d:string[],o:Float64Array,h:Float64Array,l:Float64Array,c:Float64Array},
 *           signals: object, strategy: object, capital: number, startIdx?: number, endIdx?: number }} args
 */
export function runBacktest({ bars, signals, strategy, capital, startIdx = 0, endIdx = bars.c.length - 1 }) {
  if (!(capital > 0)) throw new Error('初始資金必須大於 0');
  if (startIdx > endIdx) throw new Error('回測區間內沒有資料');
  const { o, h, l, c, d } = bars;
  const slip = strategy.costs.slippageBps / 1e4;
  const comm = strategy.costs.commissionBps / 1e4;
  const sizePct = strategy.sizing.pctEquity / 100;
  const allowShort = strategy.allowShort;

  const len = endIdx - startIdx + 1;
  const equity = new Float64Array(len);
  const inPos = new Uint8Array(len);
  const trades = [];
  let cash = capital, pos = null, pending = null, nextId = 1;

  const openPosition = (i, order) => {
    const dir = order.dir;
    const px = dir > 0 ? o[i] * (1 + slip) : o[i] * (1 - slip);
    const notional = order.shares * px;
    const fee = notional * comm;
    cash += dir > 0 ? -(notional + fee) : notional - fee;
    const sl = order.slPct > 0 ? px * (1 - dir * order.slPct / 100) : null;
    const tp = order.tpPct > 0 ? px * (1 + dir * order.tpPct / 100) : null;
    pos = { id: nextId++, dir, shares: order.shares, entryIdx: i, entryPrice: px, feeIn: fee, sl, tp };
  };

  const closePosition = (i, price, reason) => {
    const p = pos;
    const notional = p.shares * price;
    const fee = notional * comm;
    cash += p.dir > 0 ? notional - fee : -(notional + fee);
    const pnl = p.dir * p.shares * (price - p.entryPrice) - p.feeIn - fee;
    trades.push({
      id: p.id, dir: p.dir > 0 ? 'long' : 'short',
      entryIdx: p.entryIdx, exitIdx: i, entryDate: d[p.entryIdx], exitDate: d[i],
      entryPrice: p.entryPrice, exitPrice: price, shares: p.shares,
      pnl, retPct: (pnl / (p.shares * p.entryPrice)) * 100, bars: i - p.entryIdx, reason,
    });
    pos = null;
  };

  const checkStops = (i) => {
    const p = pos;
    if (p.dir > 0) {
      if (p.sl !== null && o[i] <= p.sl) return closePosition(i, o[i] * (1 - slip), 'stop_loss');
      if (p.tp !== null && o[i] >= p.tp) return closePosition(i, o[i], 'take_profit');
      if (p.sl !== null && l[i] <= p.sl) return closePosition(i, p.sl * (1 - slip), 'stop_loss');
      if (p.tp !== null && h[i] >= p.tp) return closePosition(i, p.tp, 'take_profit');
    } else {
      if (p.sl !== null && o[i] >= p.sl) return closePosition(i, o[i] * (1 + slip), 'stop_loss');
      if (p.tp !== null && o[i] <= p.tp) return closePosition(i, o[i], 'take_profit');
      if (p.sl !== null && h[i] >= p.sl) return closePosition(i, p.sl * (1 + slip), 'stop_loss');
      if (p.tp !== null && l[i] <= p.tp) return closePosition(i, p.tp, 'take_profit');
    }
    return undefined;
  };

  for (let i = startIdx; i <= endIdx; i++) {
    // 1) 上一根收盤產生的掛單,在這根開盤成交
    if (pending) {
      if (pending.type === 'exit' && pos) closePosition(i, pos.dir > 0 ? o[i] * (1 - slip) : o[i] * (1 + slip), 'signal');
      else if (pending.type === 'entry' && !pos) openPosition(i, pending);
      pending = null;
    }
    // 2) 這根 K 棒的止損/止盈
    if (pos) checkStops(i);
    // 3) 以收盤價計算權益
    const eq = cash + (pos ? pos.dir * pos.shares * c[i] : 0);
    equity[i - startIdx] = eq;
    inPos[i - startIdx] = pos ? 1 : 0;
    // 4) 收盤後判斷訊號 → 下一根開盤成交(最後一根沒有下一根,不再下單)
    if (i < endIdx && signals.valid[i]) {
      if (pos) {
        if (pos.dir > 0 ? signals.exitLong[i] : signals.exitShort[i]) pending = { type: 'exit' };
      } else {
        const dir = signals.entryLong[i] ? 1 : (allowShort && signals.entryShort[i] ? -1 : 0);
        const shares = (eq * sizePct) / c[i];
        if (dir && shares > 0 && Number.isFinite(shares)) {
          pending = {
            type: 'entry', dir, shares,
            slPct: signals.slPct ? signals.slPct[i] : NaN,
            tpPct: signals.tpPct ? signals.tpPct[i] : NaN,
          };
        }
      }
    }
  }

  const last = endIdx;
  const openPositionInfo = pos && {
    dir: pos.dir > 0 ? 'long' : 'short', entryIdx: pos.entryIdx, entryDate: d[pos.entryIdx], entryPrice: pos.entryPrice,
    shares: pos.shares, lastPrice: c[last],
    unrealized: pos.dir * pos.shares * (c[last] - pos.entryPrice) - pos.feeIn,
    sl: pos.sl, tp: pos.tp,
  };

  return { startIdx, endIdx, dates: d.slice(startIdx, endIdx + 1), equity, inPos, trades, openPosition: openPositionInfo, capital };
}
