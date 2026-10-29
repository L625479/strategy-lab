// 結果頁: KPI、權益曲線、回撤、價格圖(單一標的)/各標的表(投資組合)、月報酬熱圖、交易明細。

import { clear, download, h, isNum, money, num, pct, price, signClass, arrow } from './dom.js';
import { drawdownChart, equityChart, linkCharts, priceChart, readTheme, reasonLabel, withAlpha } from './charts.js';

// 指標線的顏色: 避開藍(獲利/策略)與紅(虧損)兩個語意色,依序取橘、青綠、黃、紫、洋紅、綠
const INDICATOR_SLOTS = [1, 2, 3, 6, 4, 5];
const MONTHS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

// ---- 小元件 ------------------------------------------------------------------

function card(title, { legend = null, actions = null } = {}, ...body) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, title), legend, actions),
    ...body);
}

const legendKey = (label, color, kind = 'line') => h('span', { class: `key ${kind === 'sw' ? 'sw' : ''}` }, h('i', { style: kind === 'sw' ? { background: color } : { borderColor: color } }), label);

function deltaLine(diff, unit, label, { goodWhenUp = true, digits = 1 } = {}) {
  if (!isNum(diff)) return h('div', { class: 'delta' }, ' ');
  const good = goodWhenUp ? diff > 0 : diff < 0;
  const cls = Math.abs(diff) < 1e-9 ? '' : good ? 'pos' : 'neg';
  const text = `${diff > 0 ? '+' : ''}${diff.toFixed(digits)}${unit}`;
  return h('div', { class: 'delta' }, h('span', { class: cls }, `${arrow(diff)} ${text}`), ` ${label}`);
}

function kpi(label, value, deltaNode) {
  return h('div', { class: 'kpi' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), deltaNode || h('div', { class: 'delta' }, ' '));
}

// ---- 熱圖色彩(發散: 藍 ↔ 灰 ↔ 紅,5 階) ------------------------------------------

const hexToRgb = (hex) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim()); return m ? [1, 2, 3].map((i) => parseInt(m[i], 16)) : [128, 128, 128]; };
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const luminance = ([r, g, b]) => { const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };

function heatColor(ret, scale, t) {
  if (!isNum(ret)) return { bg: 'transparent', fg: 'inherit' };
  // 四捨五入到 5 階: 幾乎為 0 的值(例如相關係數 -0.02)維持中性灰,不會被染成最淺的一階
  const steps = 5, step = Math.min(steps, Math.round((Math.abs(ret) / scale) * steps)) / steps;
  const rgb = mix(hexToRgb(t.mid), hexToRgb(ret >= 0 ? t.polePos : t.poleNeg), step);
  return { bg: `rgb(${rgb.join(',')})`, fg: luminance(rgb) < 0.35 ? '#ffffff' : '#0b0b0b' };
}

// ---- 各區塊 ------------------------------------------------------------------

function kpiRow(r) {
  const m = r.metrics, b = r.buyHoldMetrics, ts = r.tradeStats;
  const dpp = (x, y) => (isNum(x) && isNum(y) ? (x - y) * 100 : NaN);
  return h('div', { class: 'kpis' },
    kpi('總報酬', h('span', { class: signClass(m.totalReturn) }, pct(m.totalReturn, 1, { sign: true })), deltaLine(dpp(m.totalReturn, b.totalReturn), ' pp', '相較買入持有')),
    kpi('年化報酬 (CAGR)', pct(m.cagr, 1, { sign: true }), deltaLine(dpp(m.cagr, b.cagr), ' pp', '相較買入持有')),
    kpi('夏普比率', num(m.sharpe, 2), deltaLine(isNum(m.sharpe) && isNum(b.sharpe) ? m.sharpe - b.sharpe : NaN, '', '相較買入持有', { digits: 2 })),
    kpi('最大回撤', pct(m.maxDrawdown, 1), deltaLine(dpp(m.maxDrawdown, b.maxDrawdown), ' pp', '相較買入持有(正 = 較淺)')),
    kpi('勝率', pct(ts.winRate, 0), h('div', { class: 'delta' }, ts.n ? `${Math.round(ts.winRate * ts.n)} 勝 ${ts.n - Math.round(ts.winRate * ts.n)} 敗` : ' ')),
    kpi('盈虧因子', num(ts.profitFactor, 2), h('div', { class: 'delta' }, '總獲利 ÷ 總虧損')),
    kpi('交易次數', String(ts.n), h('div', { class: 'delta' }, `多 ${ts.longs} · 空 ${ts.shorts}${r.openPositions.length ? ` · 持有中 ${r.openPositions.length}` : ''}`)));
}

function monthEndTable(r) {
  const rows = [];
  const cal = r.calendar;
  for (let i = 0; i < cal.length; i++) {
    if (i === cal.length - 1 || cal[i].slice(0, 7) !== cal[i + 1].slice(0, 7)) rows.push(i);
  }
  const hasBench = Boolean(r.bench);
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', null, '月底'), h('th', null, '策略權益'), h('th', null, '買入持有'), hasBench ? h('th', null, `基準 ${r.bench.id}`) : null, h('th', null, '策略回撤'))),
    h('tbody', null, rows.map((i) => h('tr', null, h('td', null, cal[i]), h('td', null, money(r.equity[i])), h('td', null, money(r.buyHold[i])),
      hasBench ? h('td', null, money(r.bench.equity[i])) : null, h('td', { class: signClass(r.drawdown[i]) }, pct(r.drawdown[i], 1)))))));
}

function equityCard(r, ctx, track) {
  const t = ctx.theme;
  const lines = [{ key: 'strategy', label: '策略', color: t.s[0], values: r.equity }, { key: 'bh', label: '買入持有', color: t.muted, values: r.buyHold }];
  if (r.bench) lines.push({ key: 'bench', label: `基準 ${r.bench.id}(買入持有)`, color: t.s[1], values: r.bench.equity });
  const box = h('div', { class: 'chart eq', role: 'img', 'aria-label': '權益曲線圖;完整數值請切換「表格檢視」' });
  const tableHost = h('div', { hidden: true });
  let log = false, tableOn = false, chartApi;
  const logBtn = h('button', { type: 'button', class: 'ghost', 'aria-pressed': 'false', onClick: () => { log = !log; logBtn.setAttribute('aria-pressed', String(log)); logBtn.textContent = log ? '對數座標 ✓' : '對數座標'; chartApi.setLog(log); } }, '對數座標');
  const tblBtn = h('button', { type: 'button', class: 'ghost', onClick: () => {
    tableOn = !tableOn;
    tblBtn.textContent = tableOn ? '圖表檢視' : '表格檢視';
    box.hidden = tableOn; tableHost.hidden = !tableOn;
    if (tableOn && !tableHost.firstChild) tableHost.append(monthEndTable(r));
  } }, '表格檢視');
  const card_ = card('權益曲線', {
    legend: h('div', { class: 'legend' }, lines.map((l) => legendKey(l.label, l.color))),
    actions: h('div', { class: 'row' }, logBtn, tblBtn),
  }, box, tableHost);
  queueMicrotask(() => { chartApi = equityChart(box, { dates: r.calendar, lines }, t); track(chartApi.chart); ctx.linked.eq = chartApi.chart; ctx.link(); });
  return card_;
}

function drawdownCard(r, ctx, track) {
  const t = ctx.theme;
  const box = h('div', { class: 'chart dd', role: 'img', 'aria-label': '回撤圖' });
  const c = card('回撤(距離歷史高點)', { legend: h('div', { class: 'legend' }, legendKey('策略', t.s[0], 'sw'), legendKey('買入持有', t.muted)) }, box);
  queueMicrotask(() => { const api = drawdownChart(box, { dates: r.calendar, strategy: r.drawdown, buyHold: r.buyHoldDrawdown }, t); track(api.chart); ctx.linked.dd = api.chart; ctx.link(); });
  return c;
}

function median(xs) { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; }

function priceCard(r, ctx, track) {
  const t = ctx.theme, s = r.sleeves[0];
  const medClose = median(Array.from(s.bars.c.subarray(s.startIdx, s.endIdx + 1)));
  const inds = Object.entries(s.signals.ind).slice(0, 6).map(([name, values], k) => {
    const med = median(Array.from(values.subarray(s.startIdx, s.endIdx + 1)));
    const priceLike = Number.isFinite(med) && Number.isFinite(medClose) && med > medClose * 0.5 && med < medClose * 2;
    return { name, values, panel: priceLike ? 0 : 1, color: t.s[INDICATOR_SLOTS[k % INDICATOR_SLOTS.length]] };
  });
  const box = h('div', { class: 'chart px', role: 'img', 'aria-label': `${s.id} 價格圖與進出場標記` });
  const chipsBox = h('div', { class: 'chips-row' });
  const legend = h('div', { class: 'legend' },
    h('span', null, '空心 K 棒 = 上漲、實心 = 下跌'),
    h('span', null, '▲ 進場(灰)・▼ 出場(獲利藍、虧損紅)'));
  const c = card(`${s.id} 價格與進出場`, { legend }, chipsBox, box);
  queueMicrotask(() => {
    const api = priceChart(box, { bars: s.bars, startIdx: s.startIdx, endIdx: s.endIdx, trades: s.bt.trades, indicators: inds }, t);
    track(api.chart);
    for (const handle of api.indicators) {
      let on = true;
      const chip = h('button', { type: 'button', class: 'toggle-chip ghost', 'aria-pressed': 'true', onClick: () => {
        on = !on; chip.setAttribute('aria-pressed', String(on)); handle.series.applyOptions({ visible: on });
      } }, h('i', { style: { background: handle.color } }), handle.name);
      chipsBox.append(chip);
    }
  });
  return c;
}

function assetsCard(r, ctx) {
  const maxAbs = Math.max(1e-9, ...r.sleeves.map((s) => Math.abs(s.contribution)));
  const head = ['標的', '權重', '起始資金', '期末權益', '策略報酬', '買入持有', '最大回撤', '夏普', '交易', '勝率', '對組合報酬的貢獻'];
  const rows = r.sleeves.map((s) => {
    const info = ctx.assetInfo(s.id);
    return h('tr', null,
      h('td', { class: 'left', title: info.name }, h('span', { class: 'dot', style: { display: 'inline-block', background: `var(--s${ctx.colorSlot(s.id)})`, marginRight: '8px' }, 'aria-hidden': 'true' }), h('strong', null, s.id)),
      h('td', null, pct(s.weight, 1)), h('td', null, money(s.alloc)), h('td', null, money(s.equity[s.equity.length - 1])),
      h('td', { class: signClass(s.metrics.totalReturn) }, pct(s.metrics.totalReturn, 1, { sign: true })), h('td', { class: signClass(s.buyHoldMetrics.totalReturn) }, pct(s.buyHoldMetrics.totalReturn, 1, { sign: true })),
      h('td', null, pct(s.metrics.maxDrawdown, 1)), h('td', null, num(s.metrics.sharpe, 2)), h('td', null, String(s.tradeStats.n + (s.bt.openPosition ? 1 : 0))), h('td', null, pct(s.tradeStats.winRate, 0)),
      h('td', null, h('div', { class: 'bar-cell' }, h('span', { class: signClass(s.contribution) }, `${arrow(s.contribution)} ${pct(s.contribution, 2, { sign: true })}`),
        h('div', { class: `bar ${s.contribution < 0 ? 'n' : ''}`, style: { width: `${Math.max(2, (Math.abs(s.contribution) / maxAbs) * 70)}px` } }))));
  });
  const total = h('tr', null, h('td', { class: 'left' }, h('strong', null, '組合')), h('td', null, '100%'), h('td', null, money(r.capital)), h('td', null, money(r.equity[r.equity.length - 1])),
    h('td', { class: signClass(r.metrics.totalReturn) }, pct(r.metrics.totalReturn, 1, { sign: true })), h('td', { class: signClass(r.buyHoldMetrics.totalReturn) }, pct(r.buyHoldMetrics.totalReturn, 1, { sign: true })),
    h('td', null, pct(r.metrics.maxDrawdown, 1)), h('td', null, num(r.metrics.sharpe, 2)), h('td', null, String(r.tradeStats.n + r.openPositions.length)), h('td', null, pct(r.tradeStats.winRate, 0)), h('td', null, ''));
  const t = ctx.theme;
  const corr = r.correlation && h('div', null,
    h('h3', { style: { fontSize: '13px', margin: '14px 0 6px' } }, '標的相關係數(買入持有的日報酬;越高越代表分散效果越差)'),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, h('th', null, ''), r.correlation.ids.map((id) => h('th', null, id)))),
      h('tbody', null, r.correlation.matrix.map((row, i) => h('tr', null, h('th', { style: { position: 'static' } }, r.correlation.ids[i]),
        row.map((v) => { const c = heatColor(v, 1, t); return h('td', { style: { background: c.bg, color: c.fg } }, isNum(v) ? v.toFixed(2) : '—'); })))))));
  return card('各標的表現', {}, h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, head.map((x) => h('th', null, x)))), h('tbody', null, rows, total))), corr);
}

function monthlyCard(r, ctx) {
  const t = ctx.theme;
  const byYear = new Map();
  r.monthly.forEach((m) => { if (!byYear.has(m.year)) byYear.set(m.year, {}); byYear.get(m.year)[m.month] = m.ret; });
  const abs = r.monthly.map((m) => Math.abs(m.ret)).sort((a, b) => a - b);
  const scale = Math.max(0.03, abs[Math.floor(abs.length * 0.95)] || 0.03);
  const years = [...byYear.keys()].sort((a, b) => b - a);
  const rows = years.map((y) => {
    const months = byYear.get(y);
    const total = Object.values(months).reduce((acc, x) => acc * (1 + x), 1) - 1;
    return h('tr', null, h('td', { class: 'year' }, String(y)),
      MONTHS.map((_, k) => { const v = months[k + 1]; const c = heatColor(v, scale, t); return h('td', { style: { background: c.bg, color: c.fg }, title: isNum(v) ? `${y}-${String(k + 1).padStart(2, '0')}: ${pct(v, 2, { sign: true })}` : '' }, isNum(v) ? (v * 100).toFixed(1) : ''); }),
      h('td', { class: `total ${signClass(total)}` }, `${arrow(total)} ${pct(total, 1, { sign: true })}`));
  });
  const ramp = [-1, -0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1].map((k) => heatColor(k * scale, scale, t).bg);
  return card('月報酬 (%)', {}, h('div', { class: 'heat-wrap' }, h('table', { class: 'heat' }, h('thead', null, h('tr', null, h('th', null, ''), MONTHS.map((m) => h('th', null, `${m} 月`)), h('th', null, '全年'))), h('tbody', null, rows))),
    h('div', { class: 'scale' }, `${pct(-scale, 0)}`, ramp.map((bg) => h('i', { style: { background: bg } })), `+${pct(scale, 0)}`, h('span', { style: { marginLeft: '8px' } }, '紅 = 虧損,藍 = 獲利(格內有數字;顏色以約第 95 百分位為上限)')));
}

function detailsCard(r) {
  const cols = [['策略', r.metrics, r.tradeStats], ['買入持有', r.buyHoldMetrics, null]];
  if (r.bench) cols.push([`基準 ${r.bench.id}`, r.bench.metrics, null]);
  const T = r.tradeStats;
  const rows = [
    ['總報酬', (m) => pct(m.totalReturn, 2, { sign: true })], ['年化報酬 (CAGR)', (m) => pct(m.cagr, 2, { sign: true })], ['年化波動', (m) => pct(m.vol, 2)],
    ['夏普比率 (無風險利率 0)', (m) => num(m.sharpe, 2)], ['索提諾比率', (m) => num(m.sortino, 2)], ['卡瑪比率 (CAGR ÷ 最大回撤)', (m) => num(m.calmar, 2)],
    ['最大回撤', (m) => pct(m.maxDrawdown, 2)], ['最長水下期間 (天)', (m) => String(m.maxDdDays)], ['最佳單日', (m) => pct(m.bestDay, 2, { sign: true })], ['最差單日', (m) => pct(m.worstDay, 2, { sign: true })],
    ['期末權益', (m) => money(m.finalEquity)],
  ];
  const tradeRows = [
    ['曝險比例(有部位的天數佔比)', pct(r.exposure, 0)], ['平均單筆報酬', pct(T.avgRetPct / 100, 2, { sign: true })], ['單筆期望值(金額)', money(T.expectancy)],
    ['平均獲利 / 平均虧損(金額)', `${money(T.avgWin)} / ${money(T.avgLoss)}`], ['最佳 / 最差單筆', `${pct(T.bestPct / 100, 1, { sign: true })} / ${pct(T.worstPct / 100, 1, { sign: true })}`],
    ['平均持有根數', num(T.avgBars, 1)], ['出場原因', Object.entries(T.byReason).map(([k, v]) => `${reasonLabel(k)} ${v}`).join(' · ') || '—'],
  ];
  const metricRows = rows.map(([label, f]) => h('tr', null, h('td', null, label), cols.map((c) => h('td', null, f(c[1])))));
  const extraRows = tradeRows.map(([label, v]) => h('tr', null, h('td', null, label), h('td', null, v), cols.slice(1).map(() => h('td', null, '—'))));
  const table = h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', null, '指標'), cols.map((c) => h('th', null, c[0])))),
    h('tbody', null, metricRows, extraRows));
  return h('details', { class: 'card' }, h('summary', null, '詳細指標'),
    h('div', { class: 'body' }, h('div', { class: 'tbl-wrap' }, table)));
}

const LEFT_COLS = new Set(['symbol', 'dir', 'entryDate', 'exitDate', 'reason']);

function tradesCard(r, ctx) {
  const multi = r.sleeves.length > 1;
  const cols = [
    ...(multi ? [['symbol', '標的']] : []), ['dir', '方向'], ['entryDate', '進場日'], ['entryPrice', '進場價'], ['exitDate', '出場日'], ['exitPrice', '出場價'],
    ['bars', '持有(根)'], ['retPct', '報酬 %'], ['pnl', '損益'], ['reason', '出場原因'],
  ];
  let sortKey = 'entryDate', asc = true, showAll = false;
  const host = h('div');
  const rowsData = () => [...r.trades].sort((a, b) => { const x = a[sortKey], y = b[sortKey]; return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1); });
  const draw = () => {
    clear(host);
    const data = rowsData(), limit = showAll ? data.length : 100;
    const open = r.openPositions.map((p) => h('tr', null,
      multi ? h('td', { class: 'left' }, p.symbol) : null, h('td', { class: 'left' }, p.dir === 'long' ? '多' : '空'), h('td', { class: 'left' }, p.entryDate), h('td', null, price(p.entryPrice)),
      h('td', { class: 'left' }, '—'), h('td', null, price(p.lastPrice)), h('td', null, '—'), h('td', { class: signClass(p.unrealized) }, '—'), h('td', { class: signClass(p.unrealized) }, `${arrow(p.unrealized)} ${money(p.unrealized)}`), h('td', { class: 'left' }, h('span', { class: 'tag' }, '持有中(未實現)'))));
    host.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, cols.map(([k, label]) => h('th', { class: `sortable ${LEFT_COLS.has(k) ? 'left' : ''}`, 'aria-sort': sortKey === k ? (asc ? 'ascending' : 'descending') : 'none', onClick: () => { if (sortKey === k) asc = !asc; else { sortKey = k; asc = true; } draw(); } }, label + (sortKey === k ? (asc ? ' ▲' : ' ▼') : ''))))),
      h('tbody', null, open, data.slice(0, limit).map((tr) => h('tr', null,
        multi ? h('td', { class: 'left' }, tr.symbol) : null, h('td', { class: 'left' }, tr.dir === 'long' ? '多' : '空'), h('td', { class: 'left' }, tr.entryDate), h('td', null, price(tr.entryPrice)),
        h('td', { class: 'left' }, tr.exitDate), h('td', null, price(tr.exitPrice)), h('td', null, String(tr.bars)), h('td', { class: signClass(tr.retPct) }, `${arrow(tr.retPct)} ${tr.retPct >= 0 ? '+' : ''}${tr.retPct.toFixed(2)}%`),
        h('td', { class: signClass(tr.pnl) }, money(tr.pnl)), h('td', { class: 'left' }, h('span', { class: 'tag' }, reasonLabel(tr.reason)))))))));
    if (data.length > limit) host.append(h('p', { class: 'hint' }, `只顯示前 ${limit} 筆,共 ${data.length} 筆。 `, h('button', { type: 'button', class: 'link', onClick: () => { showAll = true; draw(); } }, '顯示全部')));
  };
  draw();
  const csv = () => {
    const header = ['symbol', 'direction', 'entry_date', 'entry_price', 'exit_date', 'exit_price', 'bars', 'return_pct', 'pnl', 'reason'];
    const lines = r.trades.map((t) => [t.symbol, t.dir, t.entryDate, t.entryPrice, t.exitDate, t.exitPrice, t.bars, t.retPct.toFixed(4), t.pnl.toFixed(2), t.reason].join(','));
    download('trades.csv', [header.join(','), ...lines].join('\n'), 'text/csv');
  };
  return card(`交易明細(${r.trades.length} 筆已平倉${r.openPositions.length ? `,${r.openPositions.length} 筆持有中` : ''})`,
    { actions: r.trades.length ? h('button', { type: 'button', class: 'ghost', onClick: csv }, '下載 CSV') : null },
    r.trades.length || r.openPositions.length ? host : h('p', { class: 'muted' }, '這段期間內策略沒有產生任何交易。可以放寬進場條件,或拉長期間。'));
}

// ---- 入口 --------------------------------------------------------------------

/**
 * ctx = { result, mode, strategyName, warnings, assetInfo(id)→{name,warn}, colorSlot(id)→1..8 }
 * 回傳 { destroy }: 重新繪製前呼叫,釋放圖表。
 */
export function renderResults(mount, ctx) {
  clear(mount);
  const r = ctx.result;
  const charts = [];
  const track = (c) => charts.push(c);
  const theme = readTheme();
  const linked = {};
  const full = { ...ctx, theme, linked, link: () => { if (linked.eq && linked.dd && !linked.done) { linkCharts(linked.eq, linked.dd); linked.done = true; } } };

  const first = r.calendar[0], last = r.calendar[r.calendar.length - 1];
  const names = r.sleeves.map((s) => s.id).join('、');
  mount.append(h('div', { class: 'status' }, h('strong', null, ctx.strategyName), ` · ${ctx.mode === 'single' ? '單一標的' : '投資組合'} ${names} · ${first} → ${last} · 起始資金 ${money(r.capital)}`));
  const notes = [...(ctx.warnings || []), ...r.warnings];
  if (notes.length) mount.append(h('div', { class: 'notice', role: 'status' }, h('ul', null, notes.map((n) => h('li', null, n)))));
  mount.append(kpiRow(r), equityCard(r, full, track), drawdownCard(r, full, track));
  mount.append(r.sleeves.length === 1 ? priceCard(r, full, track) : assetsCard(r, full));
  mount.append(monthlyCard(r, full), detailsCard(r), tradesCard(r, full));
  return { destroy: () => { charts.forEach((c) => { try { c.remove(); } catch { /* 已移除 */ } }); } };
}

export function renderEmpty(mount, hasData) {
  clear(mount);
  mount.append(h('div', { class: 'card empty' },
    h('h2', null, '還沒有回測結果'),
    h('p', null, '在左邊輸入你的策略、選好標的,按「執行回測」。'),
    h('ol', null,
      h('li', null, '從範本開始(或自己寫進出場規則)'),
      h('li', null, hasData ? '選一檔標的,或切換成投資組合設定權重' : '上傳一份價格 CSV(例如從 TradingView 匯出)'),
      h('li', null, '按「執行回測」,看績效、回撤、月報酬與每一筆交易'))));
}

export function renderError(mount, message) {
  clear(mount);
  mount.append(h('div', { class: 'errors', role: 'alert' }, h('strong', null, '無法執行回測'), h('p', null, message)));
}

export { withAlpha };
