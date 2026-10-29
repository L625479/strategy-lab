// Python 策略的結果 → 回測引擎用的訊號。Python 在伺服器端執行(tools/py_runner.py),這裡只負責驗證與轉換。
// 引擎的成交假設完全不變: 訊號在收盤確認、下一根開盤成交;止損止盈、倉位比例、手續費與滑價仍由策略設定決定。

const EVENTS = ['entry_long', 'exit_long', 'entry_short', 'exit_short'];

/**
 * @param resp    py_runner 的回應 { signals:{entry_long,...,stop_loss_pct,take_profit_pct}, valid:[0/1] }
 * @param bars    這個標的的 bars
 * @param base    computeSignals(compiled, bars) 的結果(提供暖機、以及編輯器裡設定的止損止盈)
 */
export function signalsFromPython(resp, bars, base) {
  const n = bars.c.length;
  if (!resp?.signals || !Array.isArray(resp.valid)) throw new Error('Python 策略的回應格式不正確');
  for (const k of EVENTS) {
    if (!Array.isArray(resp.signals[k]) || resp.signals[k].length !== n) throw new Error(`Python 策略回傳的 ${k} 長度與資料不同(${resp.signals[k]?.length ?? '沒有'} vs ${n})`);
  }
  if (resp.valid.length !== n) throw new Error(`Python 策略回傳的 valid 長度與資料不同(${resp.valid.length} vs ${n})`);
  const flags = (a) => Uint8Array.from(a, (x) => (x ? 1 : 0));
  const stops = (a, fallback) => {
    if (a === null || a === undefined) return fallback;                // Python 沒給 → 用編輯器裡設定的
    if (!Array.isArray(a) || a.length !== n) throw new Error('Python 策略回傳的止損 / 止盈序列長度與資料不同');
    return Float64Array.from(a, (x) => (typeof x === 'number' && x > 0 && Number.isFinite(x) ? x : NaN));
  };
  const valid = Uint8Array.from(base.valid, (v, i) => (v && resp.valid[i] ? 1 : 0));
  return {
    ...base,
    entryLong: flags(resp.signals.entry_long), exitLong: flags(resp.signals.exit_long),
    entryShort: flags(resp.signals.entry_short), exitShort: flags(resp.signals.exit_short),
    slPct: stops(resp.signals.stop_loss_pct, base.slPct), tpPct: stops(resp.signals.take_profit_pct, base.tpPct),
    valid,
  };
}

/** 要顯示在結果頁的警告: 偷看未來、部位大小被忽略、策略的 print 輸出。assetId 用來說明是哪個標的。 */
export function pythonWarnings(resp, assetId) {
  const out = [];
  const la = resp.lookahead;
  if (la?.checked && la.ok === false) {
    out.push(`⚠ ${assetId}: 這個 Python 策略疑似用到了未來的資料。把資料截短到前 ${la.cut} 根重跑時,${la.date} 的「${la.key}」和完整資料跑出來的不一樣 — 回測結果很可能高估。請檢查有沒有用 shift(-1)、整段資料的平均 / 最大最小值、或對全部資料做的標準化。`);
  } else if (la?.inconclusive) out.push(`${assetId}: 偷看未來的檢查沒有結論(${la.inconclusive})`);
  for (const w of resp.warnings || []) out.push(`${assetId}: ${w}`);
  const log = (resp.log || '').trim();
  if (log) out.push(`Python 策略的輸出(${assetId}): ${log.split('\n').slice(0, 3).join(' ⏎ ')}${log.split('\n').length > 3 ? ' …' : ''}`);
  return out;
}
