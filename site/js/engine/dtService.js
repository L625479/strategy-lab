// 當沖掃描的「服務層」: 持有面板,回答 載入 / 掃描 / holdout / 明細 的請求。
// 沒有任何 DOM 依賴,所以同一份程式碼可以放在 Web Worker 裡跑(掃描一次要十幾秒),
// 也可以在不支援 Worker 的環境直接在主執行緒呼叫,測試也直接呼叫它。

import { DEFAULTS, alignSeries, compileGrid, evaluateRules, panelFromBars, pickCandidates, splitSegments, summarizeTrace, traceRule } from './daytrade.js';
import {
  alignIntraday, allDaysSegment, confirmKeys, evaluateIntraday, halfSegments, isLive, isQualified,
} from './intraday.js';
import { intradayFromNpz, panelFromNpz } from './npz.js';

function describe(panel) {
  const dates = panel.dates;
  return {
    tickers: panel.tickers.length, days: dates.length, first: dates[0], last: dates.at(-1),
    aux: Object.keys(panel.aux || {}), ids: panel.tickers.slice(0, 2000), dropped: panel.dropped || {},
  };
}

function compileOrThrow(grid) {
  const r = compileGrid(grid);
  if (!r.ok) throw new Error(`規則有 ${r.errors.length} 個問題: ${r.errors[0].message}`);
  return r.compiled;
}

function mustHavePanel(panel) {
  if (!panel) throw new Error('還沒有載入資料');
  return panel;
}

function describeIntraday(interval, raw, a) {
  return {
    interval, bars: raw.nb, tickers: raw.m, fileDays: raw.dates.length, named: Boolean(raw.tickers),
    first: raw.dates[0], last: raw.dates.at(-1),
    ...(a ? { aligned: true, days: a.n, skipped: a.skippedDates, matched: a.matched, firstUsed: a.dates[0], lastUsed: a.dates.at(-1) } : { aligned: false }),
  };
}

const INTERVALS = ['60m', '5m'];

export function createService() {
  let panel = null;
  const intra = { '60m': null, '5m': null };                 // 盤中檔(原樣讀進來,還沒對齊)
  let aligned = {};                                           // 對齊到目前面板的結果;面板換了就作廢
  const setPanel = (p) => { panel = p; aligned = {}; return describe(panel); };
  function alignedFor(interval) {
    const raw = intra[interval];
    if (!raw) throw new Error(interval === '60m' ? '還沒有載入 60 分 K 檔' : '還沒有載入 5 分 K 檔(確認階段需要)');
    aligned[interval] ||= alignIntraday(panel, raw);
    return aligned[interval];
  }
  function intradayInfo(interval) {
    const raw = intra[interval];
    if (!raw) return null;
    try { return describeIntraday(interval, raw, panel ? alignedFor(interval) : null); } catch (err) {
      return { ...describeIntraday(interval, raw, null), error: err.message };      // 換了面板之後對不起來
    }
  }
  const cfgSegments = (cfg) => splitSegments(panel, cfg.splitDate, { devMinTrades: cfg.devMinTrades ?? 30, holdoutMinTrades: cfg.holdoutMinTrades ?? 8 });

  return {
    /** 使用者研究程式的 .npz 面板 */
    async loadNpz({ buffer }) {
      return setPanel(await panelFromNpz(buffer));
    },

    /** 多檔 bars({d,o,h,l,c}) + 外部序列(以代號為鍵)→ 對齊成面板 */
    loadBars({ entries, aux = {} }) {
      if (!entries.length) throw new Error('請至少選一檔標的');
      return setPanel(panelFromBars(entries, aux));
    },

    /** 之後才需要的外部序列(例如規則改成用 ^VIX):{ 代號: bars } */
    setAux({ aux }) {
      mustHavePanel(panel);
      for (const [ticker, bars] of Object.entries(aux)) panel.aux[ticker] = alignSeries(panel.dates, bars);
      return describe(panel);
    },

    info: () => (panel ? describe(panel) : null),

    /** 掃描整個網格,只用開發集(holdout 不會被算進去,也不會回傳)。 */
    scan(cfg, onProgress = () => {}) {
      mustHavePanel(panel);
      const compiled = compileOrThrow(cfg.grid);
      const variants = cfg.optimistic === false ? ['cons'] : ['cons', 'opt'];
      const segments = cfgSegments(cfg).slice(0, 1);
      if (!segments[0].rows.some(Boolean)) throw new Error('開發集裡沒有任何資料,請把 holdout 起始日往後移');
      const out = evaluateRules(panel, compiled, { segments, variants, thresholds: cfg.thresholds }, onProgress);
      return {
        rules: out.rules.map((r) => ({ key: r.key, side: r.side, setup: r.setup, entry: r.entry, exit: r.exit, cons: r.stats.cons.dev, opt: r.stats.opt ? r.stats.opt.dev : null })),
        dev: { first: panel.dates.find((d) => d < cfg.splitDate), days: segments[0].rows.filter(Boolean).length, last: [...panel.dates].reverse().find((d) => d < cfg.splitDate) },
        tickers: panel.tickers.length,
      };
    },

    /** holdout: 只對指定的規則,算 保守 / 2 倍成本 / 樂觀 三種。呼叫端負責提醒「只該看一次」。 */
    holdout(cfg) {
      mustHavePanel(panel);
      const compiled = compileOrThrow(cfg.grid);
      const segments = [cfgSegments(cfg)[1]];
      const out = evaluateRules(panel, compiled, { segments, variants: ['cons', 'cost2x', 'opt'], ruleKeys: cfg.keys, thresholds: cfg.thresholds });
      return {
        rules: out.rules.map((r) => ({ key: r.key, cons: r.stats.cons.holdout, cost2x: r.stats.cost2x.holdout, opt: r.stats.opt.holdout })),
        holdout: { first: panel.dates.find((d) => d >= cfg.splitDate), last: panel.dates.at(-1), days: segments[0].rows.filter(Boolean).length },
      };
    },

    // ---- 盤中 K 線驗證(60 分 K 選擇、5 分 K 確認) ----

    /** 載入一個盤中檔。interval = '60m' | '5m'(60 分 K 用來選擇與確認,5 分 K 只用在確認)。 */
    async loadIntraday({ buffer, interval }) {
      if (!INTERVALS.includes(interval)) throw new Error(`未知的盤中檔種類 ${interval}`);
      const raw = await intradayFromNpz(buffer);
      const a = panel ? alignIntraday(panel, raw) : null;       // 和面板對不起來就在這裡報錯,不要等到掃描
      intra[interval] = raw;
      if (a) aligned[interval] = a; else delete aligned[interval];
      return intradayInfo(interval);
    },

    intradayInfo: () => Object.fromEntries(INTERVALS.map((i) => [i, intradayInfo(i)])),

    /**
     * 盤中掃描(他的 run_daytrade.py --intraday): 60 分 K 的交易日對半切,只用前半 I1。
     * 算 I1 的保守與樂觀;存活候選 = I1 樂觀上界仍過 D1 與 D2;候選 = I1 保守機械決定的 通過 / (a)(b)(c)。
     * I2 與 5 分 K 不會被算進去,也不會回傳。
     */
    scanIntraday(cfg, onProgress = () => {}) {
      mustHavePanel(panel);
      const compiled = compileOrThrow(cfg.grid);
      const a = alignedFor('60m');
      const segs = halfSegments(a.n, { minTrades: cfg.minTrades ?? 5 });
      if (a.n < 2) throw new Error('60 分 K 的交易日太少,無法切成 I1 與 I2');
      const thr = { ...DEFAULTS, ...(cfg.thresholds || {}) };
      const out = evaluateIntraday(panel, a, compiled, { segments: segs.slice(0, 1), variants: ['cons', 'opt'], thresholds: thr }, onProgress);
      const rules = out.rules.map((r) => ({ key: r.key, side: r.side, setup: r.setup, entry: r.entry, exit: r.exit, cons: r.stats.cons.i1, opt: r.stats.opt.i1 }));
      const half = a.n >> 1;
      return {
        rules,
        dev: { first: a.dates[0], last: a.dates[half - 1], days: half },                 // 介面上的「開發集」= I1
        i2: { first: a.dates[half], last: a.dates.at(-1), days: a.n - half },
        tickers: panel.tickers.length, matched: a.matched,
        live: rules.filter((r) => isLive(r.opt, thr)).map((r) => r.key),
        candidates: pickCandidates(rules, (r) => r.cons, thr),
      };
    },

    /**
     * 確認階段(他的 --confirm): 對 存活候選 + 候選 看 I2(保守、樂觀、兩倍成本)與 5 分 K(保守、樂觀,所有交易日)。
     * 合格 = 存活候選,且 I2 保守過 D1–D3、I2 兩倍成本過 D1 與 D2、5 分 K 保守過 D1 與 D2。
     * 呼叫端負責提醒「只該看一次」。cfg.keys 省略時用 cfg.live 與 cfg.candidates 決定。
     */
    confirmIntraday(cfg, onProgress = () => {}) {
      mustHavePanel(panel);
      const compiled = compileOrThrow(cfg.grid);
      const a60 = alignedFor('60m'), a5 = alignedFor('5m');
      const thr = { ...DEFAULTS, ...(cfg.thresholds || {}) };
      const live = cfg.live || [], keys = cfg.keys || confirmKeys(live, cfg.candidates || {});
      if (!keys.length) throw new Error('沒有可以確認的規則(存活候選與候選都是空的)');
      const minTrades = cfg.minTrades ?? 5;
      const segs = halfSegments(a60.n, { minTrades });
      const c60 = evaluateIntraday(panel, a60, compiled, { segments: segs.slice(1), variants: ['cons', 'opt', 'cost2x'], ruleKeys: keys, thresholds: thr },
        (d, t) => onProgress(d, t * 2));
      const c5 = evaluateIntraday(panel, a5, compiled, { segments: allDaysSegment(a5.n, { minTrades: cfg.minTrades5 ?? 1 }), variants: ['cons', 'opt'], ruleKeys: keys, thresholds: thr },
        (d, t) => onProgress(t + d, t * 2));
      const by60 = new Map(c60.rules.map((r) => [r.key, r])), by5 = new Map(c5.rules.map((r) => [r.key, r]));
      const liveSet = new Set(live);
      return {
        rules: keys.map((key) => {
          const r60 = by60.get(key), r5 = by5.get(key);
          if (!r60 || !r5) throw new Error(`找不到規則 ${key}`);
          const row = { key, live: liveSet.has(key), i2: r60.stats.cons.i2, i2opt: r60.stats.opt.i2, i2x2: r60.stats.cost2x.i2, m5: r5.stats.cons.all, m5opt: r5.stats.opt.all };
          row.qualified = isQualified(row, thr);
          return row;
        }),
        i2: { first: a60.dates[a60.n >> 1], last: a60.dates.at(-1), days: a60.n - (a60.n >> 1) },
        m5: { first: a5.dates[0], last: a5.dates.at(-1), days: a5.n },
      };
    },

    /** 一條規則的明細(逐檔、逐年、報酬分佈)。segment = 'dev' | 'holdout'。 */
    detail(cfg) {
      mustHavePanel(panel);
      const compiled = compileOrThrow(cfg.grid);
      const seg = cfgSegments(cfg)[cfg.segment === 'holdout' ? 1 : 0];
      const trace = traceRule(panel, compiled, cfg.key, { variant: cfg.variant || 'cons', rowsMask: seg.rows });
      return summarizeTrace(panel, trace);
    },
  };
}
