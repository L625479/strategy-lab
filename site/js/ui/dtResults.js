// 當沖掃描的結果頁: 通過數統計、候選、散佈圖、可行邊界、全部規則、單一規則明細與 holdout。
// 所有文字走 textContent(h() 已處理):規則名稱、代號都可能來自使用者匯入的檔案。

import { DEFAULTS, frontier, passes, pickCandidates, summarize } from '../engine/daytrade.js';
import { histogramChart, scatterChart } from './dtCharts.js';
import { h, isNum, num, pct, signClass } from './dom.js';

const CAND_LABEL = { pass: '通過 D1–D3', a: '(a) 勝率過門檻', b: '(b) 平均過門檻', c: '(c) 最接近雙重目標' };

const card = (title, { actions = null, legend = null } = {}, ...body) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, title), legend, actions), ...body);
const thr = (s) => ({ ...DEFAULTS, ...s });

function badge(ok, label) {
  return h('span', { class: 'tag', style: { color: ok ? 'var(--good)' : 'var(--bad)', fontWeight: 600 }, title: ok ? '通過' : '未通過' }, `${ok ? '✓' : '✗'} ${label}`);
}

function flags(s, t) {
  const p = passes(s, t);
  return h('span', { class: 'row', style: { gap: '4px', justifyContent: 'flex-end' } }, badge(p.D1, 'D1'), badge(p.D2, 'D2'), badge(p.D3, 'D3'));
}

const fmtN = (n) => n.toLocaleString('en-US');

// ---- 小區塊 ---------------------------------------------------------------------

function criteriaLine(t) {
  return `D1 勝率 > ${pct(t.winThreshold, 0)}　D2 平均每筆淨報酬 ≥ ${pct(t.meanThreshold, 1)}　D3 > ${pct(t.passShare, 0)} 的個股「各自」勝率與平均都達標`;
}

export function summaryCard(scan, t) {
  const hasOpt = scan.rules[0]?.opt;
  const rows = [['保守(正式數字)', summarize(scan.rules, (r) => r.cons, t)]];
  if (hasOpt) rows.push(['樂觀(上界,僅供參考)', summarize(scan.rules, (r) => r.opt, t)]);
  const tbl = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, h('th', null, '成交算法'), ['D1 勝率過', 'D2 平均過', 'D1+D2 同時過', 'D3 個股達標過', '全過'].map((x) => h('th', null, x)))),
    h('tbody', null, rows.map(([label, s]) => h('tr', null, h('td', { class: 'left' }, label), [s.D1, s.D2, s.D1D2, s.D3, s.all].map((v, i) => h('td', { class: i === 4 && v ? 'pos' : '' }, `${v} / ${s.total}`)))))));
  const illusion = hasOpt && rows[1][1].all > rows[0][1].all
    ? h('div', { class: 'notice' }, `樂觀算法下有 ${rows[1][1].all} 條「全過」,保守算法只有 ${rows[0][1].all} 條。差距來自限價單:最高價可能出現在成交「之前」,樂觀算法把它算成停利。這類結果多半是假象,正式數字看保守。`)
    : null;
  return card('掃描結果', {}, h('p', { class: 'hint' }, criteriaLine(t)), tbl, illusion);
}

export function candidatesCard(scan, t, { onSelect, selected }) {
  const cands = pickCandidates(scan.rules, (r) => r.cons, t);
  const byKey = new Map(scan.rules.map((r) => [r.key, r]));
  const rows = Object.entries(cands).map(([k, key]) => ({ k, key, s: byKey.get(key).cons }));
  const body = rows.length
    ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['選法', '規則', '筆數', '勝率', '平均', '可用股', '個股達標', '驗收', ''].map((x, i) => h('th', { class: i < 2 ? 'left' : '' }, x)))),
      h('tbody', null, rows.map(({ k, key, s }) => h('tr', selected === key ? { style: { background: 'color-mix(in srgb, var(--s1) 10%, transparent)' } } : null,
        h('td', { class: 'left' }, CAND_LABEL[k]), h('td', { class: 'left' }, h('code', null, key)), h('td', null, fmtN(s.n)), h('td', null, pct(s.win, 1)),
        h('td', { class: signClass(s.mean) }, pct(s.mean, 2, { sign: true })), h('td', null, pct(s.elig, 0)), h('td', null, pct(s.stockPass, 1)), h('td', null, flags(s, t)),
        h('td', null, h('button', { type: 'button', class: 'ghost', onClick: () => onSelect(key) }, '看明細')))))))
    : h('p', { class: 'hint' }, `沒有任何規則讓超過 ${pct(t.eligShare, 0)} 的個股各自有足夠的交易筆數,無法列出候選。`);
  const none = cands.pass ? h('p', { class: 'hint' }, '通過者取平均報酬最高的一條。')
    : (rows.length ? h('p', { class: 'hint' }, '沒有規則通過 D1–D3。下面是由開發集機械決定的「最接近」候選,只供參考,不算通過: (a) 勝率過門檻者中平均最高、(b) 平均過門檻者中勝率最高、(c) min(勝率 ÷ 門檻, 平均 ÷ 門檻) 最大。') : null);
  return card('候選', {}, none, body);
}

export function scatterCard(scan, t, viewState, { onSelect, selected }) {
  const hasOpt = scan.rules[0]?.opt;
  const mount = h('div');
  const draw = () => {
    const pts = [];
    for (const r of scan.rules) {
      if (r.cons.n >= viewState.minPlotN) pts.push({ key: r.key, win: r.cons.win, mean: r.cons.mean, n: r.cons.n, series: 'cons' });
      if (viewState.showOpt && hasOpt && r.opt.n >= viewState.minPlotN) pts.push({ key: r.key, win: r.opt.win, mean: r.opt.mean, n: r.opt.n, series: 'opt' });
    }
    scatterChart(mount, pts, { winTarget: t.winThreshold, meanTarget: t.meanThreshold, selected, onSelect, describe: (p) => `${fmtN(p.n)} 筆 · 勝率 ${pct(p.win, 1)} · 平均 ${pct(p.mean, 2, { sign: true })}` });
    note.textContent = `顯示 ${pts.filter((p) => p.series === 'cons').length} / ${scan.rules.length} 條規則(筆數 ≥ ${viewState.minPlotN}),點一個點可以看明細。`;
  };
  const note = h('p', { class: 'hint' });
  const optBtn = hasOpt ? h('button', { type: 'button', class: 'ghost', 'aria-pressed': String(viewState.showOpt), onClick: (e) => {
    viewState.showOpt = !viewState.showOpt; e.currentTarget.setAttribute('aria-pressed', String(viewState.showOpt)); e.currentTarget.textContent = viewState.showOpt ? '隱藏樂觀上界' : '顯示樂觀上界'; draw();
  } }, viewState.showOpt ? '隱藏樂觀上界' : '顯示樂觀上界') : null;
  const legend = h('div', { class: 'legend' },
    h('span', { class: 'key sw' }, h('i', { style: { background: 'var(--s1)' } }), '保守(正式數字)'),
    hasOpt ? h('span', { class: 'key' }, h('i', { style: { borderColor: 'var(--s2)' } }), '樂觀(上界)') : null);
  const c = card('每條規則在哪裡', { legend, actions: optBtn }, mount, note);
  queueMicrotask(draw);
  return c;
}

export function frontierCard(scan, t, { onSelect }) {
  const f = frontier(scan.rules, (r) => r.cons, t);
  if (!f.eligible) return card('可行邊界', {}, h('p', { class: 'hint' }, `沒有任何規則讓超過 ${pct(t.eligShare, 0)} 的個股各自有足夠的交易筆數,無法畫出可行邊界。可以降低「個股最少筆數」,或載入更多標的。`));
  const byKey = new Map(scan.rules.map((r) => [r.key, r]));
  const row = (label, key) => {
    const s = byKey.get(key).cons;
    return h('tr', null, h('td', { class: 'left' }, label), h('td', { class: 'left' }, h('button', { type: 'button', class: 'link', onClick: () => onSelect(key) }, h('code', null, key))),
      h('td', null, fmtN(s.n)), h('td', null, pct(s.win, 1)), h('td', { class: signClass(s.mean) }, pct(s.mean, 2, { sign: true })), h('td', null, pct(s.stockPass, 1)));
  };
  const head = h('thead', null, h('tr', null, ['條件', '規則', '筆數', '勝率', '平均', '個股達標'].map((x, i) => h('th', { class: i < 2 ? 'left' : '' }, x))));
  return card('可行邊界', {},
    h('p', { class: 'hint' }, `只看多數個股有足夠交易筆數的 ${f.eligible} 條規則。「勝率至少 X 時,平均最高能到多少」與「平均至少 Y 時,勝率最高能到多少」:兩個目標能不能同時達到,看這張表最清楚。`),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, head, h('tbody', null,
      f.byWin.map((x) => row(`勝率 ≥ ${pct(x.threshold, 0)} 時平均最高`, x.key)),
      f.byMean.map((x) => row(`平均 ≥ ${pct(x.threshold, x.threshold < 0.01 ? 2 : 1)} 時勝率最高`, x.key))))));
}

export function rulesCard(scan, t, viewState, { onSelect, selected, rerender }) {
  const hasOpt = scan.rules[0]?.opt;
  const cols = [
    ['key', '規則', (r) => r.key, true], ['n', '筆數', (r) => r.cons.n], ['win', '勝率', (r) => r.cons.win], ['mean', '平均', (r) => r.cons.mean],
    ['elig', '可用股', (r) => r.cons.elig], ['sp', '個股達標', (r) => r.cons.stockPass],
    ...(hasOpt ? [['owin', '樂觀勝率', (r) => r.opt.win], ['omean', '樂觀平均', (r) => r.opt.mean]] : []),
  ];
  const getter = Object.fromEntries(cols.map(([id, , f]) => [id, f]));
  const q = viewState.filter.trim().toLowerCase();
  let rows = scan.rules.filter((r) => (!q || r.key.toLowerCase().includes(q)) && (viewState.side === 'all' || r.side === viewState.side) && (!viewState.onlyElig || r.cons.elig > t.eligShare));
  const dir = viewState.sortDir === 'asc' ? 1 : -1, f = getter[viewState.sortBy] || getter.mean;
  rows = [...rows].sort((a, b) => {
    const x = f(a), y = f(b);
    return (typeof x === 'string' ? x.localeCompare(y) : (x - y)) * dir || a.key.localeCompare(b.key);
  });
  const shown = rows.slice(0, viewState.limit);
  const th = ([id, label]) => h('th', {
    class: `sortable ${id === 'key' ? 'left' : ''}`, 'aria-sort': viewState.sortBy === id ? (viewState.sortDir === 'asc' ? 'ascending' : 'descending') : 'none',
    onClick: () => { if (viewState.sortBy === id) viewState.sortDir = viewState.sortDir === 'asc' ? 'desc' : 'asc'; else { viewState.sortBy = id; viewState.sortDir = id === 'key' ? 'asc' : 'desc'; } rerender(); },
  }, label + (viewState.sortBy === id ? (viewState.sortDir === 'asc' ? ' ▲' : ' ▼') : ''));
  const filter = h('input', { type: 'text', placeholder: '篩選規則名稱,例如 gap 或 lim1atr', value: viewState.filter, 'aria-label': '篩選規則', onInput: (e) => { viewState.filter = e.target.value; clearTimeout(filter._t); filter._t = setTimeout(() => rerender({ keepFocus: true }), 200); } });
  const side = h('select', { 'aria-label': '方向', onChange: (e) => { viewState.side = e.target.value; rerender(); } },
    ...[['all', '做多與放空'], ['long', '只看做多'], ['short', '只看放空']].map(([v, l]) => h('option', { value: v, selected: viewState.side === v }, l)));
  const elig = h('label', { class: 'row small muted', style: { gap: '6px' } }, h('input', { type: 'checkbox', checked: viewState.onlyElig, onChange: (e) => { viewState.onlyElig = e.target.checked; rerender(); } }), `只看多數個股有足夠筆數的規則`);
  const body = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, cols.map(th), h('th', null, '驗收'))),
    h('tbody', null, shown.map((r) => h('tr', { style: r.key === selected ? { background: 'color-mix(in srgb, var(--s1) 10%, transparent)' } : null },
      h('td', { class: 'left' }, h('button', { type: 'button', class: 'link', onClick: () => onSelect(r.key) }, h('code', null, r.key))),
      h('td', null, fmtN(r.cons.n)), h('td', null, pct(r.cons.win, 1)), h('td', { class: signClass(r.cons.mean) }, pct(r.cons.mean, 2, { sign: true })),
      h('td', null, pct(r.cons.elig, 0)), h('td', null, pct(r.cons.stockPass, 1)),
      hasOpt ? [h('td', null, pct(r.opt.win, 1)), h('td', { class: signClass(r.opt.mean) }, pct(r.opt.mean, 2, { sign: true }))] : null,
      h('td', null, flags(r.cons, t)))))));
  const more = rows.length > shown.length ? h('button', { type: 'button', class: 'ghost', onClick: () => { viewState.limit += 300; rerender(); } }, `再顯示 300 條(還有 ${rows.length - shown.length} 條)`) : null;
  return card(`全部規則(${rows.length} 條)`, { actions: h('div', { class: 'row wrap' }, elig, side, filter) }, body, more);
}

// ---- 單一規則明細 ----------------------------------------------------------------------

function statGrid(entries) {
  return h('div', { class: 'kpis' }, entries.map(([label, value, sub]) => h('div', { class: 'kpi' }, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), h('div', { class: 'delta' }, sub || ' '))));
}

function holdoutBlock(row, t, ctx) {
  const { holdout } = ctx;
  if (!holdout) {
    return h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      h('div', { class: 'notice' }, ctx.peeksText),
      h('div', null, h('button', { type: 'button', onClick: () => ctx.onHoldout(row.key) }, `看這條規則的 holdout(${ctx.holdoutRange})`)));
  }
  const dev = row.cons, hold = holdout.cons, cost = holdout.cost2x, opt = holdout.opt;
  const d4 = Object.values(passes(hold, t)).every(Boolean), p2 = passes(cost, t);
  const line = (label, s) => h('tr', null, h('td', { class: 'left' }, label), h('td', null, fmtN(s.n)), h('td', null, pct(s.win, 1)), h('td', { class: signClass(s.mean) }, pct(s.mean, 2, { sign: true })), h('td', null, pct(s.elig, 0)), h('td', null, pct(s.stockPass, 1)), h('td', null, flags(s, t)));
  return h('div', { class: 'stack', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
    h('div', { class: 'notice' }, `${ctx.peeksText} 已揭曉。從現在起,再用 holdout 的結果去調整規則,它就不再是沒看過的資料。`),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['', '筆數', '勝率', '平均', '可用股', '個股達標', '驗收'].map((x, i) => h('th', { class: i ? '' : 'left' }, x)))),
      h('tbody', null, line('開發集(保守)', dev), line('holdout(保守)', hold), line('holdout 2 倍成本', cost), line('holdout 樂觀上界', opt)))),
    h('div', { class: 'row wrap' }, badge(d4, 'D4 holdout 仍通過 D1–D3'), badge(p2.D1 && p2.D2, 'D5 2 倍成本下仍通過 D1、D2')));
}

export function detailCard(row, t, ctx) {
  const d = ctx.detail, s = row.cons;
  const histMount = h('div');
  const body = [];
  body.push(h('div', { class: 'row wrap' }, ctx.title ? h('strong', null, ctx.title) : h('code', null, row.key), flags(s, t)));
  body.push(statGrid([
    ['筆數', fmtN(s.n), '開發集的全部成交'],
    ['勝率', pct(s.win, 1), `門檻 > ${pct(t.winThreshold, 0)}`],
    ['平均每筆淨報酬', h('span', { class: signClass(s.mean) }, pct(s.mean, 2, { sign: true })), `門檻 ≥ ${pct(t.meanThreshold, 1)}`],
    ['中位數', d ? h('span', { class: signClass(d.overall.median) }, pct(d.overall.median, 2, { sign: true })) : '…', d ? `均賺 ${pct(d.overall.avgWin, 2, { sign: true })} · 均賠 ${pct(d.overall.avgLoss, 2, { sign: true })}` : ' '],
    ['個股達標', pct(s.stockPass, 1), `${pct(s.elig, 0)} 的個股有 ≥ ${ctx.devMinTrades} 筆`],
    ['樂觀上界', row.opt ? `${pct(row.opt.win, 1)} / ${pct(row.opt.mean, 2, { sign: true })}` : '同保守', row.opt ? '勝率 / 平均(最高價碰到停利就算)' : '沒有「限價進場 + 停利」,兩種算法相同'],
  ]));
  if (d && !d.overall.n) body.push(h('p', { class: 'hint' }, '開發集裡這條規則沒有任何成交。可能是條件太嚴、資料太少,或條件用到的外部序列(例如 ^VIX)沒有資料。'));
  else if (d) {
    body.push(h('h3', { style: { fontSize: '13px', margin: '8px 0 0' } }, '每筆淨報酬的分佈(開發集)'));
    body.push(histMount);
    const yearTbl = h('div', { class: 'tbl-wrap', style: { maxHeight: '300px' } }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['年', '筆數', '勝率', '平均'].map((x, i) => h('th', { class: i ? '' : 'left' }, x)))),
      h('tbody', null, d.perYear.map((y) => h('tr', null, h('td', { class: 'left' }, y.year), h('td', null, fmtN(y.n)), h('td', null, pct(y.win, 1)), h('td', { class: signClass(y.mean) }, pct(y.mean, 2, { sign: true })))))));
    const per = [...d.perTicker].sort((a, b) => b.mean - a.mean);
    const tickTbl = h('div', { class: 'tbl-wrap', style: { maxHeight: '300px' } }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['個股', '筆數', '勝率', '平均', '達標'].map((x, i) => h('th', { class: i ? '' : 'left' }, x)))),
      h('tbody', null, per.map((y) => h('tr', null, h('td', { class: 'left' }, y.id), h('td', null, fmtN(y.n)), h('td', null, pct(y.win, 1)), h('td', { class: signClass(y.mean) }, pct(y.mean, 2, { sign: true })),
        h('td', null, y.n >= ctx.devMinTrades && y.win > t.winThreshold && y.mean >= t.meanThreshold ? '✓' : ''))))));
    body.push(h('div', { class: 'row wrap', style: { alignItems: 'flex-start' } },
      h('div', { class: 'grow', style: { minWidth: '260px' } }, h('h3', { style: { fontSize: '13px', margin: '0 0 6px' } }, '逐年'), yearTbl),
      h('div', { class: 'grow', style: { minWidth: '260px' } }, h('h3', { style: { fontSize: '13px', margin: '0 0 6px' } }, `逐檔(${per.length} 檔有成交)`), tickTbl)));
    queueMicrotask(() => histogramChart(histMount, d.hist, { meanLine: s.mean }));
  } else body.push(h('p', { class: 'hint' }, '計算明細中…'));
  body.push(h('h3', { style: { fontSize: '13px', margin: '8px 0 0' } }, 'Holdout 驗證'));
  body.push(holdoutBlock(row, t, ctx));
  return card('規則明細', { actions: ctx.onClose ? h('button', { type: 'button', class: 'ghost', onClick: ctx.onClose }, '關閉') : null }, ...body);
}

export { isNum, num };
