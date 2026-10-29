// 一致性: 網站的 JS 引擎 vs 另一份獨立實作的 Python 引擎,同一份資料、同一個策略,交易必須逐筆相同。
// 標準答案(fixtures/parity_trades.json)是用 Python 引擎在 fixtures/parity_bars.csv 上跑出來的(合成資料,
// EMA 交叉 + RSI 區間過濾、無止損止盈、零成本),Python 引擎本身不在這個 repo。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { runBacktest } from '../site/js/engine/backtest.js';
import { parseCsv } from '../site/js/engine/data.js';
import { compileStrategy, computeSignals, emptyStrategy } from '../site/js/engine/strategy.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('JS 引擎與 Python 引擎在同一份資料上產生相同的交易', () => {
  const golden = JSON.parse(fixture('parity_trades.json'));
  const { bars } = parseCsv(fixture('parity_bars.csv'));
  const strategy = {
    ...emptyStrategy(),
    params: Object.entries(golden.params).map(([name, value]) => ({ name, value })),
    indicators: [
      { name: 'ema_f', expr: 'ema(close, fast)' }, { name: 'ema_s', expr: 'ema(close, slow)' }, { name: 'rsi_v', expr: 'rsi(close, rsi_n)' },
    ],
    entry: { long: 'cross_above(ema_f, ema_s) and rsi_v > lo and rsi_v < hi', short: '' },
    exit: { long: 'cross_below(ema_f, ema_s)', short: '' },
    costs: { commissionBps: 0, slippageBps: 0 },
    warmupBars: golden.warmup,
  };
  const { ok, errors, compiled } = compileStrategy(strategy);
  assert.ok(ok, JSON.stringify(errors));
  const result = runBacktest({ bars, signals: computeSignals(compiled, bars), strategy: compiled.strategy, capital: 10000 });

  assert.ok(golden.trades.length >= 15, `標準答案只有 ${golden.trades.length} 筆,比對力道不足`);
  assert.equal(result.trades.length, golden.trades.length);
  golden.trades.forEach((g, i) => {
    const t = result.trades[i];
    assert.equal(t.entryDate, g.entryDate, `第 ${i + 1} 筆進場日`);
    assert.equal(t.exitDate, g.exitDate, `第 ${i + 1} 筆出場日`);
    assert.equal(t.reason, g.reason);
    assert.ok(Math.abs(t.entryPrice - g.entryPrice) < 1e-7, `第 ${i + 1} 筆進場價 ${t.entryPrice} vs ${g.entryPrice}`);
    assert.ok(Math.abs(t.exitPrice - g.exitPrice) < 1e-7, `第 ${i + 1} 筆出場價 ${t.exitPrice} vs ${g.exitPrice}`);
  });
  assert.equal(result.openPosition ? 1 : 0, golden.open.length);
  if (golden.open.length) assert.equal(result.openPosition.entryDate, golden.open[0].entryDate);
});
