// 當沖(當日進、當日出)規則研究: 每個「標的 × 交易日」是一筆獨立的交易,沒有持倉延續與權益曲線,
// 看的是逐筆統計(勝率、平均報酬、每檔個股各自達標的比例)。
//
// 規則由四個部分組成,全部用一般的規則語法(expr.js)寫:
//   方向    做多 / 放空
//   條件    今天開盤時是否值得做(setup)
//   進場    開盤市價;或限價 = 開盤價往不利方向退 d(d 是一個運算式,結果是占開盤價的比例)
//   出場    收盤市價;或停利限價 = 進場價往有利方向 t(運算式,占進場價的比例),沒到就收盤出場
//
// 「開盤決策框架」: 條件與距離都在今天開盤時判斷,所以 high / low / close / volume 和所有指標只看得到
// **前一日(含)以前**,open 是今天的開盤價。例如 open / close - 1 就是今天的跳空幅度。
// 這樣寫出來的規則不可能偷看到今天的高低收(框架本身就把它們往後移了一天)。
//
// 成交假設(與使用者的 Python 研究程式一致):
//   限價單要被穿價 bufferBps 才算成交(只碰到不算),成交在限價;停利同樣要穿價。
//   日線分不出盤中高低點的先後。開盤市價進場時「最高價 ≥ 停利價」一定發生在進場之後,沒有歧義;
//   限價進場時最高價可能出現在成交之前,所以用兩種算法夾住真值:
//     保守 = 收盤已經越過停利價才算停利(真實績效的下界,正式數字用這個)
//     樂觀 = 最高價碰到就算(上界)
//   每筆淨報酬 = 方向 × (出場價 / 進場價 - 1) - 2 × 單邊成本。勝 = 淨報酬 > 0。
//   資料品質過濾(使用當日 K 棒): 四價缺值/非正價、高低價與開收矛盾超過 0.5%、一字線的日子不交易。

import { ExprError, analyze, asSeries, evaluate, parse } from './expr.js';
import { BUILTIN_SERIES, makeFunctions } from './indicators.js';

export const LIMITS = { name: 40, params: 30, indicators: 30, aux: 6, setups: 60, entries: 30, exits: 30, rules: 4000, expr: 500 };
export const DEFAULTS = { costBps: 5, bufferBps: 10, winThreshold: 0.8, meanThreshold: 0.01, passShare: 0.5, eligShare: 0.5 };
const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEG_NONE = 255;

// ---- 資料結構 -------------------------------------------------------------------

/** 單一規則(介面上的「單一規則」模式)。 */
export function emptyDayRule() {
  return {
    version: 1, kind: 'daytrade', name: '我的當沖規則',
    params: [],
    indicators: [{ name: 'atrp', expr: 'sma(tr(), 14) / close' }],
    aux: [],
    side: 'long',
    setup: 'true',
    entry: { limit: '' },
    exit: { takeProfit: '' },
    costBps: DEFAULTS.costBps, bufferBps: DEFAULTS.bufferBps,
  };
}

/** 規則網格: 條件(附方向)× 進場 × 出場 的所有組合。 */
export function emptyGrid() {
  return {
    version: 1, kind: 'daytrade-grid', name: '我的網格',
    params: [], indicators: [{ name: 'atrp', expr: 'sma(tr(), 14) / close' }], aux: [],
    setups: [{ side: 'long', name: 'none', expr: 'true' }],
    entries: [{ name: 'open', expr: '' }],
    exits: [{ name: 'close', expr: '' }],
    costBps: DEFAULTS.costBps, bufferBps: DEFAULTS.bufferBps,
  };
}

const str = (x, max, d = '') => (typeof x === 'string' ? x.slice(0, max) : d);
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const list = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);

function normCommon(o) {
  return {
    params: list(o.params, LIMITS.params).map((p) => ({ name: str(p?.name, 30), value: num(p?.value, 0) })),
    indicators: list(o.indicators, LIMITS.indicators).map((p) => ({ name: str(p?.name, 30), expr: str(p?.expr, LIMITS.expr) })),
    aux: list(o.aux, LIMITS.aux).map((p) => ({ name: str(p?.name, 30), ticker: str(p?.ticker, 24) })),
    costBps: num(o.costBps, DEFAULTS.costBps),
    bufferBps: num(o.bufferBps, DEFAULTS.bufferBps),
  };
}

const side = (x) => (x === 'short' ? 'short' : 'long');

export function normalizeDayRule(input) {
  const o = input && typeof input === 'object' ? input : {};
  return {
    version: 1, kind: 'daytrade', name: str(o.name, LIMITS.name, emptyDayRule().name),
    ...normCommon(o),
    side: side(o.side),
    setup: str(o.setup, LIMITS.expr),
    entry: { limit: str(o.entry?.limit, LIMITS.expr) },
    exit: { takeProfit: str(o.exit?.takeProfit, LIMITS.expr) },
  };
}

export function normalizeGrid(input) {
  const o = input && typeof input === 'object' ? input : {};
  return {
    version: 1, kind: 'daytrade-grid', name: str(o.name, LIMITS.name, emptyGrid().name),
    ...normCommon(o),
    setups: list(o.setups, LIMITS.setups).map((p) => ({ side: side(p?.side), name: str(p?.name, 40), expr: str(p?.expr, LIMITS.expr) })),
    entries: list(o.entries, LIMITS.entries).map((p) => ({ name: str(p?.name, 40), expr: str(p?.expr, LIMITS.expr) })),
    exits: list(o.exits, LIMITS.exits).map((p) => ({ name: str(p?.name, 40), expr: str(p?.expr, LIMITS.expr) })),
  };
}

/** 單一規則 = 只有一格的網格,引擎只需要處理網格這一種。 */
export function ruleToGrid(rule) {
  const r = normalizeDayRule(rule);
  return normalizeGrid({
    name: r.name, params: r.params, indicators: r.indicators, aux: r.aux, costBps: r.costBps, bufferBps: r.bufferBps,
    setups: [{ side: r.side, name: 'setup', expr: r.setup }],
    entries: [{ name: r.entry.limit.trim() ? 'limit' : 'open', expr: r.entry.limit }],
    exits: [{ name: r.exit.takeProfit.trim() ? 'tp' : 'close', expr: r.exit.takeProfit }],
  });
}

/** 使用者的 588 條標準網格: 10 個做多條件 + 4 個放空條件 × 6 種進場 × 7 種出場。名稱與他的程式的 name() 相同。 */
export function standardGrid() {
  const S = (sideName, name, expr) => ({ side: sideName, name, expr });
  const gap = 'open / close - 1';
  return normalizeGrid({
    name: 'S&P 500 當沖標準網格(588 條)',
    indicators: [{ name: 'atrp', expr: 'sma(tr(), 14) / close' }],
    aux: [{ name: 'vix', ticker: '^VIX' }],
    setups: [
      S('long', 'none', 'true'),
      S('long', 'up200', 'close > sma(close, 200)'),
      S('long', 'rsi2<10', 'rsi(close, 2) < 10'),
      S('long', 'down3', 'close < close[1] and close[1] < close[2] and close[2] < close[3]'),
      S('long', 'ret5<=-10%', 'close / close[5] - 1 <= -0.10'),
      S('long', 'gap<=-1atr', `${gap} <= -atrp`),
      S('long', 'gap<=-2atr', `${gap} <= -2 * atrp`),
      S('long', 'vix>30', 'vix > 30'),
      S('long', 'up200&rsi2<10', 'close > sma(close, 200) and rsi(close, 2) < 10'),
      S('long', 'atr>=4%', 'atrp >= 0.04'),
      S('short', 'none', 'true'),
      S('short', 'gap>=+1atr', `${gap} >= atrp`),
      S('short', 'gap>=+2atr', `${gap} >= 2 * atrp`),
      S('short', 'rsi2>90', 'rsi(close, 2) > 90'),
    ],
    entries: [{ name: 'open', expr: '' }, ...[0.5, 1, 1.5, 2, 3].map((d) => ({ name: `lim${d}atr`, expr: `${d} * atrp` }))],
    exits: [{ name: 'close', expr: '' },
      ...[0.5, 1, 2].map((k) => ({ name: `tp${k}atr`, expr: `${k} * atrp` })),
      ...[1, 2, 3].map((p) => ({ name: `tp${p}%`, expr: String(p / 100) }))],
  });
}

// ---- 編譯與驗證 -------------------------------------------------------------------

/**
 * 驗證並編譯網格。回傳 { ok, errors:[{field,message}], warnings, compiled }。
 * field 例如 'indicators[0].expr'、'setups[2].expr'、'entries[1].expr'、'exits[0].expr'、'aux[0].ticker'。
 */
export function compileGrid(input) {
  const g = normalizeGrid(input);
  const errors = [], warnings = [];
  const err = (field, message) => errors.push({ field, message });
  const funcs = makeFunctions({ c: new Float64Array(0) });
  const known = new Set(Object.keys(BUILTIN_SERIES));

  const check = (src, field, { allowEmpty = false } = {}) => {
    if (!src.trim()) { if (!allowEmpty) err(field, '這個欄位不能是空的'); return null; }
    let ast;
    try { ast = parse(src); } catch (e) {
      if (e instanceof ExprError) { err(field, e.message); return null; }
      throw e;
    }
    const { names, calls } = analyze(ast);
    for (const name of names) if (!known.has(name)) err(field, `不認得的名稱「${name}」(可用: ${[...known].join('、')})`);
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

  g.params.forEach((p, i) => { defineName(p.name, `params[${i}].name`); });
  g.aux.forEach((a, i) => {
    defineName(a.name, `aux[${i}].name`);
    if (!a.ticker.trim()) err(`aux[${i}].ticker`, '請填外部序列對應的代號(例如 ^VIX)');
  });
  const indicators = [];
  g.indicators.forEach((ind, i) => {
    const ast = check(ind.expr, `indicators[${i}].expr`);
    if (defineName(ind.name, `indicators[${i}].name`) && ast) indicators.push({ name: ind.name, ast });
  });

  const axis = (items, label, key, { allowEmpty }) => {
    if (!items.length) err(key, `至少需要一個${label}`);
    const seen = new Set();
    return items.map((it, i) => {
      if (!it.name.trim()) err(`${key}[${i}].name`, '名稱不能是空的');
      else if (/[|]/.test(it.name)) err(`${key}[${i}].name`, '名稱不能包含「|」');
      const keyName = `${it.side || ''}:${it.name}`;
      if (seen.has(keyName)) err(`${key}[${i}].name`, `名稱「${it.name}」重複了`);
      seen.add(keyName);
      return { ...it, ast: check(it.expr, `${key}[${i}].expr`, { allowEmpty }) };
    });
  };
  const setups = axis(g.setups, '條件', 'setups', { allowEmpty: false });
  const entries = axis(g.entries, '進場方式', 'entries', { allowEmpty: true });
  const exits = axis(g.exits, '出場方式', 'exits', { allowEmpty: true });

  if (!(g.costBps >= 0 && g.costBps <= 1000)) err('costBps', '單邊成本必須介於 0 到 1000 bps 之間');
  if (!(g.bufferBps >= 0 && g.bufferBps <= 1000)) err('bufferBps', '限價穿價幅度必須介於 0 到 1000 bps 之間');
  const total = setups.length * entries.length * exits.length;
  if (total > LIMITS.rules) err('setups', `規則組合共 ${total} 條,超過上限 ${LIMITS.rules} 條`);
  if (entries.some((e) => !e.expr.trim()) && entries.filter((e) => !e.expr.trim()).length > 1) err('entries', '「開盤市價」(留空)只能有一個');
  if (exits.some((e) => !e.expr.trim()) && exits.filter((e) => !e.expr.trim()).length > 1) err('exits', '「收盤出場」(留空)只能有一個');

  return {
    ok: errors.length === 0, errors, warnings,
    compiled: errors.length ? null : {
      grid: g, params: Object.fromEntries(g.params.map((p) => [p.name, p.value])), indicators, aux: g.aux,
      setups, entries, exits, costBps: g.costBps, bufferBps: g.bufferBps,
    },
  };
}

export const compileDayRule = (rule) => compileGrid(ruleToGrid(rule));

/** 展開成規則清單。順序與使用者的 Python 網格相同: 條件(依序)× 進場 × 出場。 */
export function expandRules(compiled) {
  const out = [];
  compiled.setups.forEach((s, si) => compiled.entries.forEach((e, ei) => compiled.exits.forEach((x, xi) => {
    out.push({ key: `${s.side}|${s.name}|${e.name}|${x.name}`, side: s.side, si, ei, xi, setup: s.name, entry: e.name, exit: x.name });
  })));
  return out;
}

// ---- 面板 ----------------------------------------------------------------------

/**
 * 面板 = 同一條交易日曆上的多檔日線。
 *   { dates: ['YYYY-MM-DD'...], tickers: [...], o: [Float32Array|Float64Array...], h, l, c, aux: { '^VIX': Float64Array } }
 * 每檔一條序列,長度都等於 dates.length,缺資料是 NaN。aux 是規則裡「外部序列」用的,以代號為鍵。
 */
export function validatePanel(panel) {
  const n = panel?.dates?.length;
  const ok = Array.isArray(panel?.tickers) && n > 0 && ['o', 'h', 'l', 'c'].every((k) => Array.isArray(panel[k]) && panel[k].length === panel.tickers.length
    && panel[k].every((a) => a && a.length === n));
  if (!ok) throw new Error('面板格式不正確(每檔需要與日曆等長的 o/h/l/c)');
  return panel;
}

/**
 * 把多檔 bars({d,o,h,l,c}) 對齊成同一條交易日曆。
 * 日曆 = 每一天「在世的標的(上市到最後一根之間)」裡超過一半有 K 棒的日子。這樣股票與加密貨幣混在一起時,
 * 週末(只有加密貨幣有資料)會被剔除,不會在每檔股票的資料裡留下 NaN 而讓 14 日平均這類指標永遠算不出來;
 * 不同標的上市時間不同、期間不重疊也不會被交集掉。被剔除的 K 棒數記在 panel.dropped。
 * 外部序列(以代號為鍵)對齊到這條日曆,沒有資料的日子用前值填補。
 */
export function panelFromBars(entries, auxEntries = {}) {
  const all = [...new Set(entries.flatMap(({ bars }) => bars.d))].sort();
  const pos = new Map(all.map((d, i) => [d, i]));
  const present = new Int32Array(all.length), alive = new Int32Array(all.length + 1);
  for (const { bars } of entries) {
    for (const d of bars.d) present[pos.get(d)]++;
    alive[pos.get(bars.d[0])]++; alive[pos.get(bars.d.at(-1)) + 1]--;       // 在世區間 [第一根, 最後一根]
  }
  const keep = new Uint8Array(all.length);
  let live = 0;
  for (let i = 0; i < all.length; i++) { live += alive[i]; keep[i] = present[i] * 2 > live ? 1 : 0; }
  const dates = all.filter((_, i) => keep[i]);
  const col = new Map(dates.map((d, i) => [d, i]));
  const n = dates.length;
  const panel = { dates, tickers: [], o: [], h: [], l: [], c: [], aux: {}, dropped: {} };
  for (const { id, bars } of entries) {
    const o = new Float64Array(n).fill(NaN), h = new Float64Array(n).fill(NaN), l = new Float64Array(n).fill(NaN), c = new Float64Array(n).fill(NaN);
    let lost = 0;
    bars.d.forEach((d, j) => {
      const i = col.get(d);
      if (i === undefined) { lost++; return; }
      o[i] = bars.o[j]; h[i] = bars.h[j]; l[i] = bars.l[j]; c[i] = bars.c[j];
    });
    panel.tickers.push(id); panel.o.push(o); panel.h.push(h); panel.l.push(l); panel.c.push(c);
    if (lost) panel.dropped[id] = lost;
  }
  for (const [ticker, bars] of Object.entries(auxEntries)) panel.aux[ticker] = alignSeries(dates, bars);
  return panel;
}

/** 外部序列(bars 的收盤價)對齊到面板日曆,沒有資料的日子用前一個值填補(週末與休市日)。 */
export function alignSeries(dates, bars) {
  const pos = new Map(dates.map((d, i) => [d, i]));
  const a = new Float64Array(dates.length).fill(NaN);
  bars.d.forEach((d, j) => { const i = pos.get(d); if (i !== undefined) a[i] = bars.c[j]; });
  for (let i = 1; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = a[i - 1];
  return a;
}

// ---- 逐檔準備: 資料品質、開盤決策框架、運算式求值 ------------------------------------

const shift1 = (a) => {
  const out = new Float64Array(a.length).fill(NaN);
  for (let i = 1; i < a.length; i++) out[i] = a[i - 1];
  return out;
};

/**
 * 一檔標的的執行環境。回傳:
 *   px     { o, h, l, c } 當天實際價格(高低價已修到涵蓋開收)
 *   ok     Uint8Array 當天可不可以交易(資料品質)
 *   valid  Uint8Array 所有指標都不是 NaN
 *   evalSeries(ast) 在開盤決策框架下求值,回傳長度 n 的 Float64Array
 */
export function makeTickerContext(compiled, panel, k) {
  const n = panel.dates.length;
  const to64 = (a) => (a instanceof Float64Array ? a : Float64Array.from(a));
  const O = to64(panel.o[k]), H0 = to64(panel.h[k]), L0 = to64(panel.l[k]), C = to64(panel.c[k]);
  const H = new Float64Array(n), L = new Float64Array(n), ok = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hi = Math.max(O[i], C[i]), lo = Math.min(O[i], C[i]);
    const bad = H0[i] < hi * 0.995 || L0[i] > lo * 1.005 || !(Math.min(O[i], H0[i], L0[i], C[i]) > 0);
    H[i] = Math.max(H0[i], hi); L[i] = Math.min(L0[i], lo);
    ok[i] = !bad && H[i] > L[i] ? 1 : 0;
  }

  const fh = shift1(H), fl = shift1(L), fc = shift1(C), fv = shift1(new Float64Array(n));
  const env = Object.create(null);
  Object.assign(env, compiled.params);
  env.open = O; env.high = fh; env.low = fl; env.close = fc; env.volume = fv;
  env.hl2 = fh.map((x, i) => (x + fl[i]) / 2);
  env.hlc3 = fh.map((x, i) => (x + fl[i] + fc[i]) / 3);
  for (const a of compiled.aux) env[a.name] = panel.aux?.[a.ticker] ? shift1(panel.aux[a.ticker]) : new Float64Array(n).fill(NaN);
  const ctx = { env, funcs: makeFunctions({ h: fh, l: fl, c: fc }) };

  const valid = new Uint8Array(n).fill(1);
  for (const { name, ast } of compiled.indicators) {
    const s = asSeries(evaluate(ast, ctx), n);
    env[name] = s;
    for (let i = 0; i < n; i++) if (Number.isNaN(s[i])) valid[i] = 0;
  }
  return { n, px: { o: O, h: H, l: L, c: C }, ok, valid, evalSeries: (ast) => asSeries(evaluate(ast, ctx), n) };
}

// ---- 模擬一檔標的、一條規則 -------------------------------------------------------------

/** 條件成立且資料可用的日子(索引)。 */
export function eligibleDays(ctx, setupSeries) {
  const idx = [];
  for (let i = 0; i < ctx.n; i++) if (ctx.ok[i] && ctx.valid[i] && setupSeries[i] === setupSeries[i] && setupSeries[i] !== 0) idx.push(i);
  return Int32Array.from(idx);
}

/**
 * 在 days 這些日子模擬一條規則,每筆成交呼叫 sink(day, netReturn)。
 * dist = 限價距離序列(null = 開盤市價);tp = 停利幅度序列(null = 收盤出場)。
 */
export function simulateDays(px, days, dist, tp, sideName, { optimistic = false, cost = 5e-4, buffer = 1e-3 }, sink) {
  const { o, h, l, c } = px, s = sideName === 'short' ? -1 : 1;
  for (let j = 0; j < days.length; j++) {
    const i = days[j];
    let E = o[i];
    if (dist) {
      const d = dist[i];
      if (!(d >= 0)) continue;
      E = o[i] * (1 - s * d);
      if (!(s > 0 ? l[i] <= E * (1 - buffer) : h[i] >= E * (1 + buffer))) continue;
    }
    let X = c[i];
    if (tp) {
      const t = tp[i];
      if (!(t >= 0)) continue;
      const T = E * (1 + s * t);
      const hit = !dist || optimistic ? (s > 0 ? h[i] >= T * (1 + buffer) : l[i] <= T * (1 - buffer)) : (s > 0 ? c[i] >= T : c[i] <= T);
      if (hit) X = T;
    }
    const r = s * (X / E - 1) - 2 * cost;
    if (Number.isFinite(r)) sink(i, r);
  }
}

// ---- 統計 ----------------------------------------------------------------------

/** 一個「規則 × 變體 × 時段」的累加器。個股各自的統計用來算「多少比例的個股各自達標」。 */
class Accumulator {
  constructor(nTickers, { median = false, nDays = 0 } = {}) {
    this.m = nTickers;
    this.n = 0; this.wins = 0; this.sum = 0; this.sumWin = 0; this.sumLoss = 0; this.nLoss = 0;
    this.ni = new Int32Array(nTickers); this.wi = new Int32Array(nTickers); this.si = new Float64Array(nTickers);
    this.values = median ? [] : null;
    this.daySum = nDays ? new Float64Array(nDays) : null; this.dayCnt = nDays ? new Int32Array(nDays) : null;
  }

  add(k, day, r) {
    this.n++; this.sum += r; this.ni[k]++; this.si[k] += r;
    if (r > 0) { this.wins++; this.sumWin += r; this.wi[k]++; } else { this.sumLoss += r; this.nLoss++; }
    if (this.values) this.values.push(r);
    if (this.daySum) { this.daySum[day] += r; this.dayCnt[day]++; }
  }

  finish(minTrades, thr = DEFAULTS) {
    const zero = { n: 0, days: 0, win: 0, mean: 0, median: 0, avgWin: 0, avgLoss: 0, dayMean: 0, elig: 0, stockPass: 0 };
    if (this.n === 0) return zero;
    let elig = 0, pass = 0;
    for (let k = 0; k < this.m; k++) {
      if (this.ni[k] < minTrades) continue;
      elig++;
      if (this.wi[k] / this.ni[k] > thr.winThreshold && this.si[k] / this.ni[k] >= thr.meanThreshold) pass++;
    }
    let median = 0, days = 0, dayMean = 0;
    if (this.values) {
      const v = Float64Array.from(this.values).sort();
      const mid = v.length >> 1;
      median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    }
    if (this.daySum) {
      let acc = 0;
      for (let d = 0; d < this.daySum.length; d++) if (this.dayCnt[d]) { days++; acc += this.daySum[d] / this.dayCnt[d]; }
      dayMean = days ? acc / days : 0;
    }
    return {
      n: this.n, days, win: this.wins / this.n, mean: this.sum / this.n, median,
      avgWin: this.wins ? this.sumWin / this.wins : 0, avgLoss: this.nLoss ? this.sumLoss / this.nLoss : 0,
      dayMean, elig: elig / this.m, stockPass: pass / this.m,
    };
  }
}

/** segments 是 { name, rows, minTrades } 的清單(rows = 布林陣列,哪些日子納入),轉成 每日的時段編號。 */
function segmentIndex(nDays, segments) {
  const seg = new Uint8Array(nDays).fill(SEG_NONE);
  segments.forEach((s, si) => {
    for (let i = 0; i < seg.length; i++) if (s.rows[i] && seg[i] === SEG_NONE) seg[i] = si;
  });
  return seg;
}

/** 日期字串切成兩個時段: 開發集(< splitDate)與 holdout(>= splitDate)。 */
export function splitSegments(panel, splitDate, { devMinTrades = 30, holdoutMinTrades = 8 } = {}) {
  const dev = panel.dates.map((d) => d < splitDate), hold = dev.map((x) => !x);
  return [{ name: 'dev', rows: dev, minTrades: devMinTrades }, { name: 'holdout', rows: hold, minTrades: holdoutMinTrades }];
}

export const VARIANTS = {
  cons: { id: 'cons', optimistic: false, costMultiplier: 1 },
  opt: { id: 'opt', optimistic: true, costMultiplier: 1 },
  cost2x: { id: 'cost2x', optimistic: false, costMultiplier: 2 },
};

/** 日線模式: 一天一筆交易,日期軸就是面板的日曆。盤中模式(intraday.js)提供同樣形狀的 mode。 */
function dailyMode(panel) {
  return {
    nDays: panel.dates.length,
    forTicker: (k, ctx) => ({
      days: (rows) => rows,
      series: (s) => s,
      simulate: (days, dist, tp, side, opts, sink) => simulateDays(ctx.px, days, dist, tp, side, opts, sink),
    }),
  };
}

/**
 * 評估一批規則。逐檔標的處理(DSL 運算式每檔只算一次、不同規則共用),結果依 規則 × 變體 × 時段 累加。
 *
 * @param panel     面板
 * @param compiled  compileGrid().compiled
 * @param cfg       { segments:[{name, rows, minTrades}], variants:['cons','opt',...], ruleKeys?: string[], median?, daily?, thresholds? }
 * @param onProgress (done, total) => void
 * @returns { rules: [{ key, side, setup, entry, exit, stats: { [variant]: { [segment]: stats } } }], warnings }
 */
export function evaluateRules(panel, compiled, cfg, onProgress = () => {}) {
  validatePanel(panel);
  return runRules(panel, compiled, cfg, dailyMode(panel), onProgress);
}

/**
 * evaluateRules 的核心,日線與盤中共用。mode = { nDays, forTicker(k, ctx) }:
 *   nDays        統計用的日期軸長度(segments 的 rows 就是這條軸上的布林陣列)
 *   forTicker    回傳這一檔的 { days(日線列索引 → 這條軸上的日子), series(日線序列 → 這條軸上的序列), simulate(days, dist, tp, side, opts, sink) };
 *                回傳 null = 這一檔沒有資料可用,跳過(仍計入「個股」的分母)
 */
export function runRules(panel, compiled, cfg, mode, onProgress = () => {}) {
  const segments = cfg.segments, variants = (cfg.variants || ['cons']).map((v) => (typeof v === 'string' ? VARIANTS[v] : v));
  const seg = segmentIndex(mode.nDays, segments);
  const all = expandRules(compiled);
  const wanted = cfg.ruleKeys ? new Set(cfg.ruleKeys) : null;
  const rules = wanted ? all.filter((r) => wanted.has(r.key)) : all;
  const m = panel.tickers.length;
  const accOpts = { median: Boolean(cfg.median), nDays: cfg.daily ? mode.nDays : 0 };
  const baseCost = compiled.costBps / 1e4, buffer = compiled.bufferBps / 1e4;

  // 樂觀算法只在「限價進場 + 停利」時和保守算法不同,其他規則直接共用保守的結果
  const differs = (r) => compiled.entries[r.ei].expr.trim() && compiled.exits[r.xi].expr.trim();
  const accs = rules.map((r) => variants.map((v) => (v.id === 'opt' && !differs(r) ? null : segments.map(() => new Accumulator(m, accOpts)))));

  const usedSetups = [...new Set(rules.map((r) => r.si))], usedEntries = [...new Set(rules.map((r) => r.ei))], usedExits = [...new Set(rules.map((r) => r.xi))];
  for (let k = 0; k < m; k++) {
    const ctx = makeTickerContext(compiled, panel, k);
    const run = mode.forTicker(k, ctx);
    if (run) {
      const days = new Map(usedSetups.map((si) => [si, run.days(compiled.setups[si].ast ? eligibleDays(ctx, ctx.evalSeries(compiled.setups[si].ast)) : new Int32Array(0))]));
      const dist = new Map(usedEntries.map((ei) => [ei, compiled.entries[ei].expr.trim() ? run.series(ctx.evalSeries(compiled.entries[ei].ast)) : null]));
      const tp = new Map(usedExits.map((xi) => [xi, compiled.exits[xi].expr.trim() ? run.series(ctx.evalSeries(compiled.exits[xi].ast)) : null]));
      rules.forEach((r, ri) => {
        variants.forEach((v, vi) => {
          const set = accs[ri][vi];
          if (!set) return;
          run.simulate(days.get(r.si), dist.get(r.ei), tp.get(r.xi), r.side,
            { optimistic: v.optimistic, cost: baseCost * v.costMultiplier, buffer },
            (day, ret) => { const s = seg[day]; if (s !== SEG_NONE) set[s].add(k, day, ret); });
        });
      });
    }
    onProgress(k + 1, m);
  }

  const thr = { ...DEFAULTS, ...(cfg.thresholds || {}) };
  return {
    rules: rules.map((r, ri) => {
      const stats = {};
      variants.forEach((v, vi) => {
        const src = accs[ri][vi] ? vi : variants.findIndex((x) => x.id === 'cons');
        stats[v.id] = Object.fromEntries(segments.map((s, si) => [s.name, accs[ri][src] ? accs[ri][src][si].finish(s.minTrades, thr) : null]));
      });
      return { key: r.key, side: r.side, setup: r.setup, entry: r.entry, exit: r.exit, stats };
    }),
  };
}

/** 單一規則的逐筆明細(給明細頁畫分佈、逐年、個股表)。回傳 { tickerIdx, dayIdx, net }。 */
export function traceRule(panel, compiled, key, { variant = 'cons', rowsMask = null } = {}) {
  validatePanel(panel);
  const r = expandRules(compiled).find((x) => x.key === key);
  if (!r) throw new Error(`找不到規則 ${key}`);
  const v = VARIANTS[variant];
  const ki = [], di = [], net = [];
  const baseCost = compiled.costBps / 1e4, buffer = compiled.bufferBps / 1e4;
  for (let k = 0; k < panel.tickers.length; k++) {
    const ctx = makeTickerContext(compiled, panel, k);
    const days = compiled.setups[r.si].ast ? eligibleDays(ctx, ctx.evalSeries(compiled.setups[r.si].ast)) : new Int32Array(0);
    const dist = compiled.entries[r.ei].expr.trim() ? ctx.evalSeries(compiled.entries[r.ei].ast) : null;
    const tp = compiled.exits[r.xi].expr.trim() ? ctx.evalSeries(compiled.exits[r.xi].ast) : null;
    simulateDays(ctx.px, days, dist, tp, r.side, { optimistic: v.optimistic, cost: baseCost * v.costMultiplier, buffer },
      (day, ret) => { if (!rowsMask || rowsMask[day]) { ki.push(k); di.push(day); net.push(ret); } });
  }
  return { tickerIdx: Int32Array.from(ki), dayIdx: Int32Array.from(di), net: Float64Array.from(net) };
}

/**
 * 把 traceRule 的逐筆結果整理成明細頁用的表: 逐檔個股、逐年、報酬分佈。
 * hist 的區間是 [lo, hi) 等寬 bins 個,另外有 under / over 兩個尾端(落在範圍外的筆數)。
 */
export function summarizeTrace(panel, trace, { histLo = -0.1, histHi = 0.1, bins = 40 } = {}) {
  const m = panel.tickers.length;
  const per = Array.from({ length: m }, () => ({ n: 0, wins: 0, sum: 0 }));
  const years = new Map();
  const counts = new Array(bins).fill(0);
  let under = 0, over = 0;
  const step = (histHi - histLo) / bins;
  for (let j = 0; j < trace.net.length; j++) {
    const r = trace.net[j], p = per[trace.tickerIdx[j]];
    p.n++; p.sum += r; if (r > 0) p.wins++;
    const year = panel.dates[trace.dayIdx[j]].slice(0, 4);
    const y = years.get(year) || { n: 0, wins: 0, sum: 0 };
    y.n++; y.sum += r; if (r > 0) y.wins++;
    years.set(year, y);
    if (r < histLo) under++; else if (r >= histHi) over++; else counts[Math.min(bins - 1, Math.floor((r - histLo) / step))]++;
  }
  const fmt = (x) => ({ n: x.n, win: x.n ? x.wins / x.n : NaN, mean: x.n ? x.sum / x.n : NaN });
  const sorted = Float64Array.from(trace.net).sort(), nn = sorted.length, mid = nn >> 1;
  let wins = 0, sumWin = 0, sumLoss = 0, sum = 0;
  for (const r of sorted) { sum += r; if (r > 0) { wins++; sumWin += r; } else sumLoss += r; }
  return {
    overall: {
      n: nn, win: nn ? wins / nn : NaN, mean: nn ? sum / nn : NaN, median: nn ? (nn % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : NaN,
      avgWin: wins ? sumWin / wins : NaN, avgLoss: nn - wins ? sumLoss / (nn - wins) : NaN,
    },
    perTicker: panel.tickers.map((id, k) => ({ id, ...fmt(per[k]) })).filter((x) => x.n > 0),
    perYear: [...years.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([year, x]) => ({ year, ...fmt(x) })),
    hist: { lo: histLo, hi: histHi, bins, counts, under, over },
  };
}

// ---- 驗收與選擇 -------------------------------------------------------------------

/** D1 勝率、D2 平均報酬、D3 多數個股各自達標。 */
export function passes(s, thr = DEFAULTS) {
  return { D1: s.win > thr.winThreshold, D2: s.mean >= thr.meanThreshold, D3: s.stockPass > thr.passShare };
}

/**
 * 「選擇樣本機械決定」: 有通過 D1–D3 的取平均報酬最高者;否則取最接近的 (a)(b)(c)。
 * rows: [{ key, stats: {cons: {dev: stats}} }],getter 取出要看的統計。
 */
export function pickCandidates(rows, get, thr = DEFAULTS) {
  const ok = rows.filter((r) => Object.values(passes(get(r), thr)).every(Boolean));
  if (ok.length) return { pass: ok.reduce((a, b) => (get(b).mean > get(a).mean ? b : a)).key };
  const el = rows.filter((r) => get(r).elig > thr.eligShare);
  if (!el.length) return {};
  const best = (arr, f) => arr.reduce((a, b) => (f(b) > f(a) ? b : a));
  const out = { c: best(el, (r) => Math.min(get(r).win / thr.winThreshold, get(r).mean / thr.meanThreshold)).key };
  const a = el.filter((r) => get(r).win > thr.winThreshold), b = el.filter((r) => get(r).mean >= thr.meanThreshold);
  if (a.length) out.a = best(a, (r) => get(r).mean).key;
  if (b.length) out.b = best(b, (r) => get(r).win).key;
  return out;
}

/** 可行邊界: 各個勝率門檻下平均最高的規則、各個平均門檻下勝率最高的規則(只看多數個股有足夠交易數的規則)。 */
export function frontier(rows, get, thr = DEFAULTS) {
  const el = rows.filter((r) => get(r).elig > thr.eligShare);
  const byWin = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((w) => {
    const g = el.filter((r) => get(r).win >= w);
    return g.length ? { threshold: w, key: g.reduce((a, b) => (get(b).mean > get(a).mean ? b : a)).key } : null;
  }).filter(Boolean);
  const byMean = [0, 0.001, 0.0025, 0.005, 0.01].map((m) => {
    const g = el.filter((r) => get(r).mean >= m);
    return g.length ? { threshold: m, key: g.reduce((a, b) => (get(b).win > get(a).win ? b : a)).key } : null;
  }).filter(Boolean);
  return { eligible: el.length, byWin, byMean };
}

/** 「588 條中 D1 過 x、D2 過 y、D1+D2 同時過 z、D3 過 w、全過 v」 */
export function summarize(rows, get, thr = DEFAULTS) {
  const p = rows.map((r) => passes(get(r), thr));
  const count = (f) => p.filter(f).length;
  return { total: rows.length, D1: count((x) => x.D1), D2: count((x) => x.D2), D1D2: count((x) => x.D1 && x.D2), D3: count((x) => x.D3), all: count((x) => x.D1 && x.D2 && x.D3) };
}
