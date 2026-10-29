// 用真實價格(tools/fetch_prices.py 抓的)重現研究筆記裡記載的結果,並排印出來比較。
//   python tools/fetch_prices.py --out /tmp/data && node tools/reproduce_notes.mjs /tmp/data
// 只印出差距,不判定通過與否: 筆記的資料截止日、利率序列、報酬定義可能和這裡略有不同。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { priceFileName, toBars } from '../site/js/engine/data.js';
import { buildWeightsData, compileWeights } from '../site/js/engine/weights.js';
import { runWeights } from '../site/js/engine/weightsrun.js';
import { getWeightsTemplate } from '../site/js/engine/weightsTemplates.js';

const dir = process.argv[2] || 'site/data';
const bars = (id) => toBars(JSON.parse(readFileSync(join(dir, 'prices', `${priceFileName(id)}.json`), 'utf8')));

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const line = (label, m) => `  ${label.padEnd(34)} CAGR ${pct(m.cagr).padStart(7)}  Sharpe ${m.sharpe.toFixed(2).padStart(5)}  最大回撤 ${pct(m.maxDrawdown).padStart(7)}  年化波動 ${pct(m.vol, 0).padStart(4)}`;
const note = (label, cagr, sharpe, dd, vol) => `  ${label.padEnd(34)} CAGR ${pct(cagr).padStart(7)}  Sharpe ${sharpe.toFixed(2).padStart(5)}  最大回撤 ${pct(dd).padStart(7)}${vol ? `  年化波動 ${pct(vol, 0).padStart(4)}` : ''}`;

/** 例: 筆記裡 GOOG 規則在 holdout 2022-04-29 → 2026-10-07 的結果 */
const CASES = [
  { title: 'GOOG 波動管理(筆記的 GOOG v7)', template: 'vol_ratio', ticker: 'GOOG', start: '2022-04-29', end: '2026-10-07',
    notes: [['筆記: 策略(holdout)', 0.308, 0.94, -0.316, 0.35], ['筆記: GOOG 買進持有', 0.272, 0.91, -0.321, 0.32], ['筆記: SPY 買進持有', 0.160, 0.96, -0.188, 0.17]], bench: 'SPY' },
  { title: 'QQQ 波動管理 + 200 日線閘門(筆記的 v11)', template: 'vol_ratio_gate', ticker: 'QQQ', start: '2021-03-30', end: '2026-10-07',
    notes: [['筆記: 策略(holdout)', 0.229, 1.00, -0.319], ['筆記: QQQ 買進持有', 0.179, 0.85, -0.351], ['筆記: SPY 買進持有', 0.146, 0.90, -0.245]], bench: 'SPY' },
  { title: 'AMAT 套用同一個 v11 規則', template: 'vol_ratio_gate', ticker: 'AMAT', start: '2021-05-28', end: '2026-10-08',
    notes: [['筆記: 策略(holdout)', 0.306, 0.80, -0.511], ['筆記: AMAT 買進持有', 0.288, 0.78, -0.551], ['筆記: SPY 買進持有', 0.137, 0.85, -0.245]], bench: 'SPY' },
];

for (const c of CASES) {
  const t = getWeightsTemplate(c.template).strategy;
  const strategy = { ...t, name: c.title, series: t.series.map((s) => (s.name === 'px' ? { ...s, ticker: c.ticker } : s)).concat(c.bench ? [{ name: 'bench', ticker: c.bench }] : []) };
  const compiled = compileWeights(strategy);
  if (!compiled.ok) { console.log(`${c.title}: 編譯失敗`, compiled.errors); continue; }
  const data = buildWeightsData(compiled.compiled, Object.fromEntries(strategy.series.map((s) => [s.ticker, bars(s.ticker)])));
  console.log(`\n== ${c.title}  ${c.start} → ${c.end}`);
  // 預設做法(筆記的慣例): 策略從資料開頭就在跑,績效只取該期間(部位延續下來)
  const a = runWeights(compiled.compiled, data, { capital: 100000, start: c.start, end: c.end, benchmark: 'bench' });
  console.log(line('這裡: 策略(從資料開頭跑、取該期間)', a.metrics));
  console.log(line(`這裡: ${c.ticker} 買進持有`, a.buyHoldMetrics));
  if (a.benchMetrics) console.log(line('這裡: SPY 買進持有', a.benchMetrics));
  console.log(`  平均曝險 ${a.account.avgGross.toFixed(2)} 倍,${pct(a.account.shareLevered, 0)} 的日子使用融資,成交 ${a.account.fills} 筆,融資利息 ${a.account.financing.toFixed(0)}、現金利息 ${a.account.interest.toFixed(0)}、成本 ${a.account.costs.toFixed(0)}`);
  // 對照做法: 從起始日當天空手開始
  const flat = runWeights(compiled.compiled, data, { capital: 100000, start: c.start, end: c.end, carryIn: false });
  console.log(line('這裡: 策略(從起始日空手開始)', flat.metrics));
  for (const n of c.notes) console.log(note(...n));
}
