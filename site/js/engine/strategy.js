// 策略模型: 資料結構、範本、驗證、編譯成可執行訊號。
// 策略是純資料(JSON),可以存、匯出、放進分享連結。

import { ExprError, analyze, asSeries, asSignal, evaluate, parse } from './expr.js';
import { BUILTIN_SERIES, makeFunctions } from './indicators.js';

export const LIMITS = { name: 40, params: 30, indicators: 30, expr: 500 };
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function emptyStrategy() {
  return {
    version: 1,
    name: '我的策略',
    params: [],
    indicators: [],
    entry: { long: '', short: '' },
    exit: { long: '', short: '' },
    allowShort: false,
    stopLoss: { mode: 'none', pct: 5, atrN: 14, atrMult: 2, expr: '' },
    takeProfit: { mode: 'none', pct: 10, atrN: 14, atrMult: 4, expr: '' },
    sizing: { pctEquity: 100 },
    costs: { commissionBps: 5, slippageBps: 5 },
    warmupBars: 50,
  };
}

const P = (name, value) => ({ name, value });
const I = (name, expr) => ({ name, expr });

function tpl(id, name, description, patch) {
  return { id, name, description, strategy: { ...emptyStrategy(), name, ...patch } };
}

export const TEMPLATES = [
  tpl('ema_rsi', 'EMA 交叉 + RSI 過濾', '短 EMA 上穿長 EMA 且 RSI 不在極端區才進場,死亡交叉出場;ATR 動態止損止盈(風報比 1:2)。',
    {
      params: [P('fast', 12), P('slow', 26), P('rsi_n', 14), P('rsi_lo', 25), P('rsi_hi', 75)],
      indicators: [I('ema_f', 'ema(close, fast)'), I('ema_s', 'ema(close, slow)'), I('rsi_v', 'rsi(close, rsi_n)')],
      entry: { long: 'cross_above(ema_f, ema_s) and rsi_v > rsi_lo and rsi_v < rsi_hi', short: '' },
      exit: { long: 'cross_below(ema_f, ema_s)', short: '' },
      stopLoss: { mode: 'atr', pct: 5, atrN: 14, atrMult: 2, expr: '' },
      takeProfit: { mode: 'atr', pct: 10, atrN: 14, atrMult: 4, expr: '' },
    }),
  tpl('sma_cross', '均線交叉 (SMA)', '快線上穿慢線買進,下穿賣出。最經典的趨勢跟隨。',
    {
      params: [P('fast', 20), P('slow', 50)],
      indicators: [I('ma_f', 'sma(close, fast)'), I('ma_s', 'sma(close, slow)')],
      entry: { long: 'cross_above(ma_f, ma_s)', short: '' },
      exit: { long: 'cross_below(ma_f, ma_s)', short: '' },
    }),
  tpl('sma_cross_ls', '均線交叉 (可做空)', '快線上穿做多、下穿做空,隨時持有一個方向的部位。',
    {
      params: [P('fast', 20), P('slow', 50)],
      indicators: [I('ma_f', 'sma(close, fast)'), I('ma_s', 'sma(close, slow)')],
      entry: { long: 'cross_above(ma_f, ma_s)', short: 'cross_below(ma_f, ma_s)' },
      exit: { long: 'cross_below(ma_f, ma_s)', short: 'cross_above(ma_f, ma_s)' },
      allowShort: true,
    }),
  tpl('donchian', '通道突破 (Donchian)', '收盤突破前 N 日最高價進場,跌破前 M 日最低價出場。注意 [1] 代表用「前一根」的通道,避免用到當根資料。',
    {
      params: [P('n_in', 20), P('n_out', 10)],
      indicators: [I('hi_n', 'highest(high, n_in)[1]'), I('lo_m', 'lowest(low, n_out)[1]')],
      entry: { long: 'close > hi_n', short: '' },
      exit: { long: 'close < lo_m', short: '' },
    }),
  tpl('rsi_reversion', 'RSI 超賣反彈', 'RSI 跌到超賣區買進,回到中性區賣出;8% 固定止損。逆勢策略,在強趨勢中容易被連續打止損。',
    {
      params: [P('rsi_n', 14), P('rsi_lo', 30), P('rsi_exit', 55)],
      indicators: [I('rsi_v', 'rsi(close, rsi_n)')],
      entry: { long: 'rsi_v < rsi_lo', short: '' },
      exit: { long: 'rsi_v > rsi_exit', short: '' },
      stopLoss: { mode: 'pct', pct: 8, atrN: 14, atrMult: 2, expr: '' },
    }),
  tpl('bollinger', '布林通道均值回歸', '收盤跌破下軌買進,回到中軌賣出。',
    {
      params: [P('n', 20), P('k', 2)],
      indicators: [I('bb_lo', 'bb_lower(close, n, k)'), I('mid', 'sma(close, n)')],
      entry: { long: 'close < bb_lo', short: '' },
      exit: { long: 'close > mid', short: '' },
    }),
  tpl('macd_cross', 'MACD 交叉', 'MACD 線上穿訊號線買進,下穿賣出。',
    {
      params: [P('fast', 12), P('slow', 26), P('sig', 9)],
      indicators: [I('m', 'macd(close, fast, slow)'), I('s', 'macd_signal(close, fast, slow, sig)')],
      entry: { long: 'cross_above(m, s)', short: '' },
      exit: { long: 'cross_below(m, s)', short: '' },
    }),
  tpl('trend_pullback', '長期趨勢 + 短線回檔 (RSI2)', '股價在 200 日均線之上,且 2 日 RSI 極低時買進回檔,站上 5 日均線賣出。',
    {
      params: [P('trend', 200), P('rsi_n', 2), P('rsi_lo', 10), P('exit_n', 5)],
      indicators: [I('ma_trend', 'sma(close, trend)'), I('rsi_v', 'rsi(close, rsi_n)'), I('ma_exit', 'sma(close, exit_n)')],
      entry: { long: 'close > ma_trend and rsi_v < rsi_lo', short: '' },
      exit: { long: 'close > ma_exit', short: '' },
      warmupBars: 200,
    }),
  tpl('buy_hold', '買入持有 (基準)', '第一天買進、一路持有。拿來當作其他策略的比較基準。',
    { entry: { long: 'true', short: '' }, exit: { long: '', short: '' }, warmupBars: 0, costs: { commissionBps: 5, slippageBps: 5 } }),
  tpl('custom', '空白 (自訂)', '從一個簡單範例開始改:收盤站上 50 日均線買進,跌破賣出。',
    {
      params: [P('n', 50)],
      indicators: [I('ma', 'sma(close, n)')],
      entry: { long: 'close > ma', short: '' },
      exit: { long: 'close < ma', short: '' },
    }),
];

export const getTemplate = (id) => TEMPLATES.find((t) => t.id === id);

// ---- 清理(匯入/分享連結來的資料不可信) -----------------------------------

const str = (x, max, d = '') => (typeof x === 'string' ? x.slice(0, max) : d);
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const bool = (x) => x === true;

function normStop(s, d) {
  const o = s && typeof s === 'object' ? s : {};
  const mode = ['none', 'pct', 'atr', 'expr'].includes(o.mode) ? o.mode : 'none';
  return { mode, pct: num(o.pct, d.pct), atrN: num(o.atrN, d.atrN), atrMult: num(o.atrMult, d.atrMult), expr: str(o.expr, LIMITS.expr) };
}

/** 把任意物件整理成合法的策略結構(缺的補預設,型別不對的丟掉) */
export function normalizeStrategy(input) {
  const base = emptyStrategy();
  const o = input && typeof input === 'object' ? input : {};
  const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);
  return {
    version: 1,
    name: str(o.name, LIMITS.name, base.name),
    params: list(o.params, LIMITS.params).map((p) => ({ name: str(p?.name, 30), value: num(p?.value, 0) })),
    indicators: list(o.indicators, LIMITS.indicators).map((p) => ({ name: str(p?.name, 30), expr: str(p?.expr, LIMITS.expr) })),
    entry: { long: str(o.entry?.long, LIMITS.expr), short: str(o.entry?.short, LIMITS.expr) },
    exit: { long: str(o.exit?.long, LIMITS.expr), short: str(o.exit?.short, LIMITS.expr) },
    allowShort: bool(o.allowShort),
    stopLoss: normStop(o.stopLoss, base.stopLoss),
    takeProfit: normStop(o.takeProfit, base.takeProfit),
    sizing: { pctEquity: num(o.sizing?.pctEquity, base.sizing.pctEquity) },
    costs: {
      commissionBps: num(o.costs?.commissionBps, base.costs.commissionBps),
      slippageBps: num(o.costs?.slippageBps, base.costs.slippageBps),
    },
    warmupBars: Math.round(num(o.warmupBars, base.warmupBars)),
  };
}

// ---- 編譯與驗證 -----------------------------------------------------------

function stopExpression(stop, label, err) {
  switch (stop.mode) {
    case 'none': return null;
    case 'pct':
      if (!(stop.pct > 0 && stop.pct <= 100)) err(label, `${label}的百分比必須介於 0 到 100 之間`);
      return String(stop.pct);
    case 'atr':
      if (!(Number.isInteger(stop.atrN) && stop.atrN >= 1 && stop.atrN <= 500)) err(label, `${label}的 ATR 週期必須是 1~500 的整數`);
      if (!(stop.atrMult > 0 && stop.atrMult <= 50)) err(label, `${label}的 ATR 倍數必須介於 0 到 50 之間`);
      return `atr(${stop.atrN}) / close * 100 * ${stop.atrMult}`;
    case 'expr':
      if (!stop.expr.trim()) err(label, `${label}選了自訂表達式但內容是空的`);
      return stop.expr.trim() || null;
    default: return null;
  }
}

/**
 * 驗證並編譯策略。回傳 { ok, errors:[{field,message}], warnings:[string], compiled }。
 * field 對應 UI 的欄位,例如 'params[1].name'、'indicators[0].expr'、'entry.long'、'stopLoss'。
 */
export function compileStrategy(strategy) {
  const s = normalizeStrategy(strategy);
  const errors = [], warnings = [];
  const err = (field, message) => errors.push({ field, message });
  const funcs = makeFunctions({ c: new Float64Array(0) }); // 只用來檢查函式名稱與參數個數

  const known = new Set(Object.keys(BUILTIN_SERIES));
  const check = (src, field, { allowEmpty = false } = {}) => {
    if (!src.trim()) { if (!allowEmpty) err(field, '這個欄位不能是空的'); return null; }
    let ast;
    try { ast = parse(src); } catch (e) {
      if (e instanceof ExprError) { err(field, e.message); return null; }
      throw e;
    }
    const { names, calls } = analyze(ast);
    for (const name of names) {
      if (!known.has(name)) err(field, `不認得的名稱「${name}」(可用: ${[...known].join('、')})`);
    }
    for (const [fname, argc] of calls) {
      if (!Object.hasOwn(funcs, fname)) { err(field, `不認得的函式「${fname}」`); continue; }
      const d = funcs[fname];
      if (argc < d.min || argc > d.max) err(field, `函式 ${fname} 需要 ${d.min === d.max ? d.min : `${d.min}~${d.max}`} 個參數,收到 ${argc} 個`);
    }
    return ast;
  };

  const defineName = (name, field) => {
    if (!IDENT.test(name)) { err(field, `名稱「${name}」只能用英文字母、數字、底線,且不能以數字開頭`); return false; }
    if (KEYWORDS.has(name)) { err(field, `「${name}」是保留字,請換一個名稱`); return false; }
    if (known.has(name)) { err(field, `名稱「${name}」重複了(或與內建名稱衝突)`); return false; }
    known.add(name);
    return true;
  };

  s.params.forEach((p, i) => {
    defineName(p.name, `params[${i}].name`);
  });
  const indicators = [];
  s.indicators.forEach((ind, i) => {
    const ast = check(ind.expr, `indicators[${i}].expr`);
    if (defineName(ind.name, `indicators[${i}].name`) && ast) indicators.push({ name: ind.name, ast });
  });

  const rule = (src, field, opts) => check(src, field, opts);
  const entryLong = rule(s.entry.long, 'entry.long', { allowEmpty: s.allowShort });
  const entryShort = s.allowShort ? rule(s.entry.short, 'entry.short', { allowEmpty: true }) : null;
  const exitLong = rule(s.exit.long, 'exit.long', { allowEmpty: true });
  const exitShort = s.allowShort ? rule(s.exit.short, 'exit.short', { allowEmpty: true }) : null;
  if (s.allowShort && !s.entry.long.trim() && !s.entry.short.trim()) err('entry.long', '做多與做空的進場條件至少要填一個');

  const slSrc = stopExpression(s.stopLoss, '止損', (f, m) => err('stopLoss', m));
  const tpSrc = stopExpression(s.takeProfit, '止盈', (f, m) => err('takeProfit', m));
  const slAst = slSrc ? check(slSrc, 'stopLoss') : null;
  const tpAst = tpSrc ? check(tpSrc, 'takeProfit') : null;

  if (!(s.sizing.pctEquity > 0 && s.sizing.pctEquity <= 1000)) err('sizing.pctEquity', '每次投入的淨值比例必須介於 0 到 1000 之間');
  else if (s.sizing.pctEquity > 100) warnings.push(`每次投入 ${s.sizing.pctEquity}% 的淨值,等於使用 ${(s.sizing.pctEquity / 100).toFixed(1)} 倍槓桿(回測不計算融資利息與強制平倉)`);
  for (const [k, label] of [['commissionBps', '手續費'], ['slippageBps', '滑價']]) {
    if (!(s.costs[k] >= 0 && s.costs[k] <= 1000)) err(`costs.${k}`, `${label}必須介於 0 到 1000 bps 之間`);
  }
  if (!(s.warmupBars >= 0 && s.warmupBars <= 2000)) err('warmupBars', '暖機根數必須介於 0 到 2000 之間');

  const hasExit = Boolean(exitLong || exitShort || slAst || tpAst);
  if (!hasExit && !/^\s*true\s*$/.test(s.entry.long)) warnings.push('沒有任何出場條件、止損或止盈:進場後會一路持有到回測結束');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    compiled: errors.length ? null : {
      strategy: s,
      params: Object.fromEntries(s.params.map((p) => [p.name, p.value])),
      indicators,
      rules: { entryLong, entryShort, exitLong, exitShort },
      stops: { sl: slAst, tp: tpAst },
    },
  };
}

/** 在一檔標的的整段歷史上計算指標與訊號。bars = { n, d, o, h, l, c, v } */
export function computeSignals(compiled, bars) {
  const n = bars.c.length;
  const env = Object.create(null);
  Object.assign(env, compiled.params);
  env.open = bars.o; env.high = bars.h; env.low = bars.l; env.close = bars.c; env.volume = bars.v;
  env.hl2 = bars.h.map((x, i) => (x + bars.l[i]) / 2);
  env.hlc3 = bars.h.map((x, i) => (x + bars.l[i] + bars.c[i]) / 3);
  const ctx = { env, funcs: makeFunctions(bars) };

  const ind = {};
  for (const { name, ast } of compiled.indicators) {
    ind[name] = asSeries(evaluate(ast, ctx), n);
    env[name] = ind[name];
  }
  const sig = (ast) => (ast ? asSignal(evaluate(ast, ctx), n) : new Uint8Array(n));
  const stop = (ast) => {
    if (!ast) return null;
    const v = asSeries(evaluate(ast, ctx), n);
    return v.map((x) => (x > 0 && Number.isFinite(x) ? x : NaN));
  };

  const valid = new Uint8Array(n);
  const names = Object.keys(ind);
  const warmup = compiled.strategy.warmupBars;
  for (let i = warmup; i < n; i++) valid[i] = names.every((k) => !Number.isNaN(ind[k][i])) ? 1 : 0;

  return {
    ind,
    entryLong: sig(compiled.rules.entryLong),
    entryShort: sig(compiled.rules.entryShort),
    exitLong: sig(compiled.rules.exitLong),
    exitShort: sig(compiled.rules.exitShort),
    slPct: stop(compiled.stops.sl),
    tpPct: stop(compiled.stops.tp),
    valid,
  };
}

// ---- 分享連結 ---------------------------------------------------------------

const toB64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (text) => {
  const b = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
};

export function encodeShare(obj) {
  return toB64Url(new TextEncoder().encode(JSON.stringify(obj)));
}

export function decodeShare(text) {
  if (typeof text !== 'string' || text.length > 40000) throw new Error('分享連結太長或格式不對');
  return JSON.parse(new TextDecoder().decode(fromB64Url(text)));
}
