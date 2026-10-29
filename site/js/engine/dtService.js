// 當沖掃描的「服務層」: 持有面板,回答 載入 / 掃描 / holdout / 明細 的請求。
// 沒有任何 DOM 依賴,所以同一份程式碼可以放在 Web Worker 裡跑(掃描一次要十幾秒),
// 也可以在不支援 Worker 的環境直接在主執行緒呼叫,測試也直接呼叫它。

import { alignSeries, compileGrid, evaluateRules, panelFromBars, splitSegments, summarizeTrace, traceRule } from './daytrade.js';
import { panelFromNpz } from './npz.js';

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

export function createService() {
  let panel = null;
  const cfgSegments = (cfg) => splitSegments(panel, cfg.splitDate, { devMinTrades: cfg.devMinTrades ?? 30, holdoutMinTrades: cfg.holdoutMinTrades ?? 8 });

  return {
    /** 使用者研究程式的 .npz 面板 */
    async loadNpz({ buffer }) {
      panel = await panelFromNpz(buffer);
      return describe(panel);
    },

    /** 多檔 bars({d,o,h,l,c}) + 外部序列(以代號為鍵)→ 對齊成面板 */
    loadBars({ entries, aux = {} }) {
      if (!entries.length) throw new Error('請至少選一檔標的');
      panel = panelFromBars(entries, aux);
      return describe(panel);
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
