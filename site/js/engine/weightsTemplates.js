// 目標權重策略的範本。「依描述實作」的範本是根據研究筆記的文字描述寫成的,沒有和原本的程式逐筆對照過;
// 實際數字請用自己的資料驗證(tools/reproduce_notes.mjs 會把結果和筆記裡記載的數字並排印出來)。

import { emptyWeightsStrategy } from './weights.js';

const S = (patch) => ({ ...emptyWeightsStrategy(), ...patch });
const P = (name, value) => ({ name, value });
const I = (name, expr) => ({ name, expr });

/** 9 組視窗(短 10/20/40 × 長 126/252/504 日)的「長期波動 ÷ 短期波動」,各自上限 cap,取平均 */
export const volRatioExpr = (cap = 2) => {
  const terms = [];
  for (const l of [126, 252, 504]) for (const s of [10, 20, 40]) terms.push(`min(${cap}, l${l} / s${s})`);
  return `avg(${terms.join(', ')})`;
};
const volIndicators = (prefix = '', ret = 'ret(close)') => [10, 20, 40, 126, 252, 504].map((n) => I(`${n < 100 ? 's' : 'l'}${n}`, `std(${ret}, ${n})`));

const IRX = { name: 'irx', ticker: '^IRX' };
const RATES = { mode: 'series', series: 'irx', constantPct: 0 };

export const WEIGHT_TEMPLATES = [
  { id: 'buy_hold', name: '買進持有 1 倍(基準)', description: '權重永遠是 1。拿來和其他權重策略比較。',
    strategy: S({ name: '買進持有 1 倍', series: [{ name: 'px', ticker: 'SPY' }], weights: [{ series: 'px', expr: '1' }] }) },
  { id: 'fixed_lev', name: '固定 1.5 倍槓桿', description: '權重永遠是 1.5,融資部分付「利率 + 利差」。看槓桿本身的代價。',
    strategy: S({ name: '固定 1.5 倍槓桿', series: [{ name: 'px', ticker: 'SPY' }, IRX], weights: [{ series: 'px', expr: '1.5' }], rates: RATES }) },
  { id: 'trend_gate', name: '200 日線濾網(站上 1.5 倍、跌破空手)', description: '收盤站上 200 日均線持有 1.5 倍,否則空手(閒置現金賺利息)。',
    strategy: S({ name: '200 日線濾網', series: [{ name: 'px', ticker: 'SPY' }, IRX], params: [P('n', 200), P('lev', 1.5)], weights: [{ series: 'px', expr: 'ifelse(close > sma(close, n), lev, 0)' }], rates: RATES }) },
  { id: 'vol_target', name: '波動目標(目標年化波動 15%,上限 2 倍)', description: '權重 = 目標波動 ÷ 近 20 日已實現年化波動,夾在 0 到 2 之間。波動大就減碼、平靜就加碼。',
    strategy: S({ name: '波動目標', series: [{ name: 'px', ticker: 'SPY' }, IRX], params: [P('target', 0.15), P('n', 20)],
      indicators: [I('vol', 'std(ret(close), n) * sqrt(252)')], weights: [{ series: 'px', expr: 'clip(target / vol, 0, 2)' }], rates: RATES }) },
  { id: 'vol_ratio', name: '波動管理(長/短波動比,9 組視窗平均,上限 2 倍)— 依描述實作', description: '曝險 = 9 組視窗(短 10/20/40 × 長 126/252/504 日)的 min(2, 長期波動 ÷ 短期波動) 取平均;波動暴增時減碼、平靜時最多 2 倍(融資)。依研究筆記的文字描述實作,尚未與原程式逐筆對照。',
    strategy: S({ name: '波動管理 v7', series: [{ name: 'px', ticker: 'GOOG' }, IRX], indicators: volIndicators(), weights: [{ series: 'px', expr: volRatioExpr(2) }], rates: RATES }) },
  { id: 'vol_ratio_gate', name: '波動管理 + 200 日線槓桿閘門(跌破時上限 1 倍)— 依描述實作', description: '上一個策略,但收盤低於 200 日均線時曝險上限 1 倍(不強制出場)。依研究筆記的文字描述實作,尚未與原程式逐筆對照。',
    strategy: S({ name: '波動管理 v11', series: [{ name: 'px', ticker: 'QQQ' }, IRX], indicators: volIndicators(), weights: [{ series: 'px', expr: `min(${volRatioExpr(2)}, ifelse(close < sma(close, 200), 1, 2))` }], rates: RATES }) },
];

export const getWeightsTemplate = (id) => WEIGHT_TEMPLATES.find((t) => t.id === id);
