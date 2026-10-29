// 用「真實的」Yahoo 驗證輸入代號自動下載(需要網路;GitHub Actions 的 live-fetch-check 工作流程會跑它):
//   1. Node 版(tools/yahoo.mjs)與 Python 版(tools/fetch_prices.py)對同一批真實代號抓下來、清理後的序列必須逐筆相同
//   2. 啟動真正的本機伺服器,打 /api/search 與 /api/prices,確認回應與 loadSymbol 一致、找不到的代號回 404
//   node tools/live_check.mjs <python 輸出的 json>
// 結束代碼: 0 = 全部通過;1 = 有不一致;2 = Yahoo 連不上(不算通過)。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { FetchError, buildSeries, fetchChart, parseChart, verdict, loadSymbol } from './yahoo.mjs';
import { startServer } from './serve.mjs';

const py = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const results = [];
let failed = false, unreachable = 0;
const check = (ok, label, detail = '') => { results.push(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`); if (!ok) failed = true; };

// ---- 1. Node 版 vs Python 版 ----
// (a) 同一份 Yahoo 原始回應(Python 抓的)丟給兩邊清理: 序列與判定必須「完全」相同 → 驗證清理程式碼
// (b) 兩邊各自獨立向 Yahoo 抓一次: Yahoo 兩次回應的數字本身可能差一點點(浮點雜訊),所以比對日期、成交量,價格容許最後一位有效數字的差異,並印出差多少
const REL_TOL = 1.5e-5;
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);
for (const [symbol, want] of Object.entries(py)) {
  if (want.fetch_error) { results.push(`SKIP ${symbol}: Python 版抓取失敗(${want.fetch_error})`); unreachable++; continue; }
  // (a)
  const parsedA = parseChart(want.raw);
  const { series: sa, stats: ta } = buildSeries(parsedA, want.today_local);
  const va = verdict(sa, ta, want.today_local);
  const sameA = JSON.stringify(sa) === JSON.stringify(want.series);
  let detailA = `n=${ta.n} ${sa.d[0]} ~ ${sa.d.at(-1)} 修正=${ta.repaired} 空值=${ta.null} 過期比=${(ta.stale_share * 100).toFixed(1)}%`;
  if (!sameA) {
    const i = sa.d.findIndex((d, k) => d !== want.series.d[k] || ['o', 'h', 'l', 'c', 'v'].some((c) => sa[c][k] !== want.series[c][k]));
    detailA += `  首個差異在第 ${i} 筆: JS ${JSON.stringify(['d', 'o', 'h', 'l', 'c', 'v'].map((c) => sa[c][i]))} vs Python ${JSON.stringify(['d', 'o', 'h', 'l', 'c', 'v'].map((c) => want.series[c][i]))}`;
  }
  check(sameA, `${symbol}: 同一份原始回應,JS 與 Python 清理後的序列完全相同`, detailA);
  check(va.ok === want.ok && va.warn === want.warn && va.reason === want.reason, `${symbol}: 同一份原始回應,品質判定相同`, `ok=${va.ok} warn=${JSON.stringify(va.warn)} reason=${JSON.stringify(va.reason)}`);

  // (b)
  let rawB;
  try { rawB = await fetchChart(symbol, 26, new Date()); } catch (e) {
    if (e instanceof FetchError) { results.push(`SKIP ${symbol}: JS 版抓取失敗(${e.message})`); unreachable++; continue; }
    throw e;
  }
  const rq = want.raw.chart.result[0], bq = rawB.chart.result[0];
  const rawDiff = {};
  for (const [name, get] of [['open', (r) => r.indicators.quote[0].open], ['high', (r) => r.indicators.quote[0].high], ['low', (r) => r.indicators.quote[0].low], ['close', (r) => r.indicators.quote[0].close], ['adjclose', (r) => r.indicators.adjclose?.[0]?.adjclose]]) {
    const x = get(rq), y = get(bq);
    if (!x || !y || x.length !== y.length) { rawDiff[name] = 'length'; continue; }
    let n = 0, mx = 0;
    x.forEach((v, i) => { if (v !== y[i]) { n++; if (v != null && y[i] != null) mx = Math.max(mx, rel(v, y[i])); } });
    rawDiff[name] = `${n}處 最大相對差 ${mx.toExponential(1)}`;
  }
  results.push(`INFO ${symbol}: 兩次獨立下載的「原始回應」差異(個數/最大相對差): ${JSON.stringify(rawDiff)};時間戳${JSON.stringify(rq.timestamp) === JSON.stringify(bq.timestamp) ? '相同' : '不同'}`);
  const parsedB = parseChart(rawB);
  const todayB = new Date(Date.now() + parsedB.offset * 1000).toISOString().slice(0, 10);
  const { series: sb } = buildSeries(parsedB, todayB);
  const sameDates = JSON.stringify(sb.d) === JSON.stringify(want.series.d);
  let n = 0, mx = 0;
  if (sameDates) for (let i = 0; i < sb.d.length; i++) for (const c of ['o', 'h', 'l', 'c']) { if (sb[c][i] !== want.series[c][i]) { n++; mx = Math.max(mx, rel(sb[c][i], want.series[c][i])); } }
  check(sameDates && JSON.stringify(sb.v) === JSON.stringify(want.series.v) && mx <= REL_TOL, `${symbol}: 兩次獨立下載清理後,日期與成交量相同、價格差不超過 ${REL_TOL}`, `價格有 ${n} 個數字不同,最大相對差 ${mx.toExponential(2)}(共 ${sb.d.length * 4} 個)`);
}

// ---- 2. 真正的伺服器 ----
const server = await startServer(resolve(fileURLToPath(new URL('../site', import.meta.url))), 0, { api: {} });
const base = `http://127.0.0.1:${server.address().port}`;
const api = async (path) => { const r = await fetch(base + path, { headers: { 'X-Strategy-Lab': '1' } }); return { status: r.status, body: await r.json().catch(() => null) }; };
try {
  const s1 = await api('/api/search?q=apple');
  if (s1.status !== 200) { results.push(`SKIP /api/search: HTTP ${s1.status} ${JSON.stringify(s1.body)}`); unreachable++; }
  else {
    check(s1.body.some((x) => x.symbol === 'AAPL' && x.type === '股票'), '/api/search?q=apple 含 AAPL(股票)', JSON.stringify(s1.body.slice(0, 4)));
    const s2 = await api(`/api/search?q=${encodeURIComponent('台積電')}`);
    check(s2.status === 422 && /不支援中文/.test(s2.body?.error || ''), '/api/search?q=台積電: 說明 Yahoo 搜尋不支援中文(不送出請求)', `${s2.status} ${s2.body?.error}`);
    const s4 = await api('/api/search?q=2330');
    check(s4.status === 200 && s4.body[0]?.symbol === '2330.TW', '/api/search?q=2330 第一筆是 2330.TW', JSON.stringify(s4.body?.slice?.(0, 2)));
    const s5 = await api('/api/search?q=taiwan%20semiconductor');
    check(s5.status === 200 && s5.body.some((x) => x.symbol === 'TSM'), '/api/search?q=taiwan semiconductor 含 TSM', JSON.stringify(s5.body?.slice?.(0, 3)));
    const s3 = await api('/api/search?q=tesla');
    check(s3.status === 200 && s3.body.some((x) => x.symbol === 'TSLA'), '/api/search?q=tesla 含 TSLA', JSON.stringify(s3.body?.slice?.(0, 3)));
  }
  const p = await api('/api/prices?symbol=aapl');
  if (p.status !== 200) { results.push(`SKIP /api/prices AAPL: HTTP ${p.status} ${JSON.stringify(p.body)}`); unreachable++; }
  else {
    const direct = await loadSymbol('AAPL');
    const mxc = direct.c.reduce((m, v, i) => Math.max(m, rel(v, p.body.c[i])), 0);
    check(p.body.symbol === 'AAPL' && JSON.stringify(p.body.d) === JSON.stringify(direct.d) && mxc <= REL_TOL, '/api/prices?symbol=aapl 與 loadSymbol 相同(日期相同、收盤價差不超過容許值)', `n=${p.body.d.length} name=${JSON.stringify(p.body.name)} ${p.body.exchange} ${p.body.currency} 最後一根=${p.body.d.at(-1)} 收盤價最大相對差 ${mxc.toExponential(2)}`);
    check(p.body.adjusted === true && /Yahoo/.test(p.body.source), '回應標示調整後價格與來源');
  }
  const nf = await api('/api/prices?symbol=ZZZZNOTREAL');
  check(nf.status === 404 && /找不到代號/.test(nf.body?.error || ''), '找不到的代號回 404 與說明', `${nf.status} ${nf.body?.error}`);
  const tw = await api('/api/prices?symbol=2330.tw');
  results.push(`INFO 2330.tw → ${tw.status} ${tw.status === 200 ? `${tw.body.symbol} ${tw.body.name} n=${tw.body.d.length} ${tw.body.d[0]}~${tw.body.d.at(-1)} ${tw.body.currency}` : JSON.stringify(tw.body)}`);
  const fx = await api('/api/prices?symbol=EURUSD=X');
  results.push(`INFO EURUSD=X → ${fx.status} ${fx.status === 200 ? `n=${fx.body.d.length} 警告=${JSON.stringify(fx.body.warn)}` : JSON.stringify(fx.body)}`);
} finally { server.close(); }

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('OK')).length} 項通過,${results.filter((r) => r.startsWith('FAIL')).length} 項失敗,${unreachable} 項因為連不上而略過`);
process.exit(failed ? 1 : unreachable ? 2 : 0);
