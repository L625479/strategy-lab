// 目標權重策略: 每天收盤算出「每個標的應該占淨值多少比例」(可以大於 1 = 槓桿、小於 0 = 放空),
// 隔天開盤依目標調整部位。沒有「進場 / 出場」訊號,也沒有止損,風險靠權重本身控制(例如波動管理)。
//
// 這個檔案是策略的資料結構、驗證與求值;成交、融資利息等帳戶運算在 weightsrun.js。
//
// 規則語法與其他分頁相同。可用的名稱:
//   每個資料序列 x:    x_open  x_high  x_low  x_close  x_volume      (例如 spy_close、oil_close)
//   第一個交易標的:    open high low close volume hl2 hlc3             (簡寫,等於它自己的 x_close …)
//   參數、指標:        你自己定義的名稱
// 權重運算式在「每一天收盤後」求值,只能看到當天(含)以前的資料;隔天開盤成交。

import { ExprError, analyze, asSeries, evaluate, parse } from './expr.js';
import { panelFromBars } from './daytrade.js';
import { BUILTIN_SERIES, makeFunctions } from './indicators.js';

export const LIMITS = { name: 40, series: 12, params: 30, indicators: 40, expr: 500 };
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELDS = [['open', 'o'], ['high', 'h'], ['low', 'l'], ['close', 'c'], ['volume', 'v']];

export function emptyWeightsStrategy() {
  return {
    version: 1, kind: 'weights', name: '我的權重策略',
    series: [{ name: 'px', ticker: 'SPY' }],
    params: [], indicators: [],
    weights: [{ series: 'px', expr: '1' }],
    rates: { mode: 'constant', series: '', constantPct: 0 },
    band: 10, maxGross: 2, allowShort: false, warmupBars: 0,
    costs: { sideBps: 5, borrowFeePct: 3, financingSpreadPct: 1 },
  };
}

const str = (x, max, d = '') => (typeof x === 'string' ? x.slice(0, max) : d);
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);

export function normalizeWeightsStrategy(input) {
  const base = emptyWeightsStrategy(), o = input && typeof input === 'object' ? input : {};
  return {
    version: 1, kind: 'weights', name: str(o.name, LIMITS.name, base.name),
    series: list(o.series, LIMITS.series).map((s) => ({ name: str(s?.name, 30), ticker: str(s?.ticker, 24) })),
    params: list(o.params, LIMITS.params).map((p) => ({ name: str(p?.name, 30), value: num(p?.value, 0) })),
    indicators: list(o.indicators, LIMITS.indicators).map((p) => ({ name: str(p?.name, 30), expr: str(p?.expr, LIMITS.expr) })),
    weights: list(o.weights, LIMITS.series).map((w) => ({ series: str(w?.series, 30), expr: str(w?.expr, LIMITS.expr) })),
    rates: {
      mode: o.rates?.mode === 'series' ? 'series' : 'constant',
      series: str(o.rates?.series, 30), constantPct: num(o.rates?.constantPct, base.rates.constantPct),
    },
    band: num(o.band, base.band), maxGross: num(o.maxGross, base.maxGross), allowShort: o.allowShort === true,
    warmupBars: Math.round(num(o.warmupBars, base.warmupBars)),
    costs: {
      sideBps: num(o.costs?.sideBps, base.costs.sideBps), borrowFeePct: num(o.costs?.borrowFeePct, base.costs.borrowFeePct),
      financingSpreadPct: num(o.costs?.financingSpreadPct, base.costs.financingSpreadPct),
    },
  };
}

/** 驗證並編譯。回傳 { ok, errors:[{field,message}], warnings, compiled }。 */
export function compileWeights(input) {
  const s = normalizeWeightsStrategy(input);
  const errors = [], warnings = [];
  const err = (field, message) => errors.push({ field, message });
  const funcs = makeFunctions({ c: new Float64Array(0) });
  const known = new Set(Object.keys(BUILTIN_SERIES));

  const check = (src, field) => {
    if (!src.trim()) { err(field, '這個欄位不能是空的'); return null; }
    let ast;
    try { ast = parse(src); } catch (e) {
      if (e instanceof ExprError) { err(field, e.message); return null; }
      throw e;
    }
    const { names, calls } = analyze(ast);
    for (const name of names) if (!known.has(name)) err(field, `不認得的名稱「${name}」(可用: ${[...known].slice(0, 14).join('、')}…)`);
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

  // 資料序列: 先定義好每個序列的 x_open … 名稱,指標與權重才能引用
  const seriesNames = new Set();
  if (!s.series.length) err('series', '至少需要一個資料序列');
  s.series.forEach((x, i) => {
    if (!IDENT.test(x.name) || KEYWORDS.has(x.name)) { err(`series[${i}].name`, `序列名稱「${x.name}」只能用英文字母、數字、底線,且不能以數字開頭`); return; }
    if (seriesNames.has(x.name)) { err(`series[${i}].name`, `序列名稱「${x.name}」重複了`); return; }
    if (!x.ticker.trim()) err(`series[${i}].ticker`, '請選擇這個序列對應的標的代號');
    seriesNames.add(x.name);
    for (const [field] of FIELDS) defineName(`${x.name}_${field}`, `series[${i}].name`);
  });
  s.params.forEach((p, i) => { defineName(p.name, `params[${i}].name`); });
  const indicators = [];
  s.indicators.forEach((ind, i) => {
    const ast = check(ind.expr, `indicators[${i}].expr`);
    if (defineName(ind.name, `indicators[${i}].name`) && ast) indicators.push({ name: ind.name, ast });
  });

  if (!s.weights.length) err('weights', '至少要為一個標的寫目標權重');
  const seen = new Set();
  const weights = s.weights.map((w, i) => {
    if (!seriesNames.has(w.series)) err(`weights[${i}].series`, `權重指定的序列「${w.series}」不存在`);
    if (seen.has(w.series)) err(`weights[${i}].series`, `序列「${w.series}」的權重重複了`);
    seen.add(w.series);
    return { series: w.series, ast: check(w.expr, `weights[${i}].expr`) };
  });

  if (s.rates.mode === 'series' && !seriesNames.has(s.rates.series)) err('rates.series', '請選擇利率序列(例如 ^IRX),或改用固定利率');
  if (!(s.rates.constantPct >= 0 && s.rates.constantPct <= 50)) err('rates.constantPct', '固定利率必須介於 0 到 50 (%) 之間');
  if (!(s.band >= 0 && s.band <= 100)) err('band', '再平衡帶必須介於 0 到 100 (%) 之間');
  if (!(s.maxGross > 0 && s.maxGross <= 10)) err('maxGross', '總曝險上限必須介於 0 到 10 倍之間');
  if (!(s.warmupBars >= 0 && s.warmupBars <= 5000)) err('warmupBars', '暖機根數必須介於 0 到 5000 之間');
  if (!(s.costs.sideBps >= 0 && s.costs.sideBps <= 1000)) err('costs.sideBps', '單邊成本必須介於 0 到 1000 bps 之間');
  if (!(s.costs.borrowFeePct >= 0 && s.costs.borrowFeePct <= 100)) err('costs.borrowFeePct', '借券費必須介於 0 到 100 (%/年) 之間');
  if (!(s.costs.financingSpreadPct >= 0 && s.costs.financingSpreadPct <= 50)) err('costs.financingSpreadPct', '融資利差必須介於 0 到 50 (%/年) 之間');
  if (s.maxGross > 3) warnings.push(`總曝險上限 ${s.maxGross} 倍: 融資利息與借券費會明顯侵蝕報酬,回測也不模擬追繳保證金與強制平倉(權益歸零才停止)`);
  if (s.rates.mode === 'constant' && s.rates.constantPct === 0) warnings.push('利率設為 0%: 閒置現金不計息、融資只付利差。要接近真實請改用利率序列(例如 ^IRX)');

  return {
    ok: errors.length === 0, errors, warnings,
    compiled: errors.length ? null : { strategy: s, params: Object.fromEntries(s.params.map((p) => [p.name, p.value])), indicators, weights, primary: s.weights[0].series },
  };
}

// ---- 資料對齊 -------------------------------------------------------------------

/** 輔助序列(只拿來當訊號)對齊到日曆: 缺的日子用前值填補。 */
function alignOHLCV(dates, bars) {
  const pos = new Map(dates.map((d, i) => [d, i]));
  const mk = () => new Float64Array(dates.length).fill(NaN);
  const out = { o: mk(), h: mk(), l: mk(), c: mk(), v: mk() };
  bars.d.forEach((d, j) => {
    const i = pos.get(d);
    if (i === undefined) return;
    out.o[i] = bars.o[j]; out.h[i] = bars.h[j]; out.l[i] = bars.l[j]; out.c[i] = bars.c[j]; out.v[i] = bars.v ? bars.v[j] : 0;
  });
  for (const a of Object.values(out)) for (let i = 1; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = a[i - 1];
  return out;
}

/**
 * 把各序列的 bars 整理成同一條日曆。交易標的決定日曆(超過一半的在世標的有 K 棒的日子,見 panelFromBars),
 * 只當訊號的序列對齊到這條日曆並用前值填補。barsByTicker: { 代號: { d,o,h,l,c,v } }。
 */
export function buildWeightsData(compiled, barsByTicker) {
  const defs = compiled.strategy.series, tradableNames = compiled.weights.map((w) => w.series);
  const bars = (x) => {
    const b = barsByTicker[x.ticker];
    if (!b) throw new Error(`找不到 ${x.ticker} 的價格資料`);
    return b;
  };
  const tradDefs = tradableNames.map((n) => defs.find((x) => x.name === n));
  const panel = panelFromBars(tradDefs.map((x) => ({ id: x.name, bars: bars(x) })));
  const dates = panel.dates;
  const tradables = tradDefs.map((x, k) => ({ name: x.name, ticker: x.ticker, o: panel.o[k], h: panel.h[k], l: panel.l[k], c: panel.c[k], v: new Float64Array(dates.length) }));
  for (const t of tradables) {
    const b = bars(defs.find((x) => x.name === t.name)), pos = new Map(b.d.map((d, j) => [d, j]));
    t.v = Float64Array.from(dates, (d) => { const j = pos.get(d); return j === undefined || !b.v ? NaN : b.v[j]; });
  }
  const series = Object.fromEntries(tradables.map((t) => [t.name, t]));
  for (const x of defs) if (!series[x.name]) series[x.name] = alignOHLCV(dates, bars(x));
  return { dates, tradables, series, dropped: panel.dropped };
}

// ---- 求值 -------------------------------------------------------------------------

/** 在整段歷史上求出每個交易標的的目標權重(Float64Array,NaN 表示還沒有足夠資料)。 */
export function evaluateWeights(compiled, data) {
  const n = data.dates.length;
  const env = Object.create(null);
  Object.assign(env, compiled.params);
  for (const [name, s] of Object.entries(data.series)) for (const [field, key] of FIELDS) env[`${name}_${field}`] = s[key];
  const p = data.series[compiled.primary];
  env.open = p.o; env.high = p.h; env.low = p.l; env.close = p.c; env.volume = p.v;
  env.hl2 = p.h.map((x, i) => (x + p.l[i]) / 2);
  env.hlc3 = p.h.map((x, i) => (x + p.l[i] + p.c[i]) / 3);
  const ctx = { env, funcs: makeFunctions({ h: p.h, l: p.l, c: p.c }) };
  const ind = {};
  for (const { name, ast } of compiled.indicators) { ind[name] = asSeries(evaluate(ast, ctx), n); env[name] = ind[name]; }
  const weights = compiled.weights.map((w) => asSeries(evaluate(w.ast, ctx), n));
  return { weights, ind };
}

/** 利率序列(年利率,小數)。固定利率或某個序列的收盤價 ÷ 100(例如 ^IRX);沒有值的日子當作 0。 */
export function rateSeries(compiled, data) {
  const n = data.dates.length, r = compiled.strategy.rates;
  if (r.mode === 'constant') return new Float64Array(n).fill(r.constantPct / 100);
  const c = data.series[r.series].c;
  return Float64Array.from(c, (x) => (Number.isFinite(x) && x >= 0 ? x / 100 : 0));
}
