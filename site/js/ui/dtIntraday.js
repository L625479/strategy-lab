// 「盤中驗證」的結果區塊: 存活候選、規則明細(I1 → I2 → 5 分 K)與確認階段的合格表。
// 其餘的卡片(通過數、候選、散佈圖、可行邊界、全部規則)和日線掃描共用 dtResults.js。
// 所有文字走 textContent(h() 已處理):規則名稱可能來自使用者匯入的檔案。

import { failedChecks } from '../engine/intraday.js';
import { badge, card, flags, fmtN } from './dtResults.js';
import { h, pct, signClass } from './dom.js';

const CAND_TAG = { pass: '通過', a: '(a)', b: '(b)', c: '(c)' };

export const ILLUSION = (opt, cons) => `樂觀算法下有 ${opt} 條「全過」,保守算法只有 ${cons} 條。差距來自同一根 K 棒:限價單成交和停利出現在同一根 K 棒裡時,K 棒內的先後仍分不出來,樂觀算法把它算成停利。這類結果多半是假象,正式數字看保守。`;

/** 一行統計(保守 / 樂觀 / 兩倍成本…)的表格列 */
function statRow(label, s, t, { d3 = true, note = '' } = {}) {
  return h('tr', null,
    h('td', { class: 'left' }, label, note ? h('span', { class: 'muted', style: { marginLeft: '6px' } }, note) : null),
    h('td', null, fmtN(s.n)), h('td', null, pct(s.win, 1)), h('td', { class: signClass(s.mean) }, pct(s.mean, 2, { sign: true })),
    h('td', null, pct(s.elig, 0)), h('td', null, d3 ? pct(s.stockPass, 1) : '—'), h('td', null, flags(s, t)));
}

const STAT_HEAD = h('thead', null, h('tr', null, ['', '筆數', '勝率', '平均', '可用股', '個股達標', '驗收'].map((x, i) => h('th', { class: i ? '' : 'left' }, x))));

/** 存活候選: I1 的樂觀上界仍然通過 D1 與 D2。連上界都過不了的規則,盤中也不可能達標。 */
export function liveCard(scan, t, view, { onSelect, selected, rerender }) {
  const byKey = new Map(scan.rules.map((r) => [r.key, r]));
  const rows = scan.live.map((k) => byKey.get(k)).sort((a, b) => b.cons.mean - a.cons.mean || a.key.localeCompare(b.key));
  if (!rows.length) {
    return card('存活候選', {}, h('p', { class: 'hint' }, `沒有任何規則的 I1 樂觀上界同時過 D1(勝率 > ${pct(t.winThreshold, 0)})與 D2(平均 ≥ ${pct(t.meanThreshold, 1)})。上界都過不了,代表這組規則在盤中也不可能達標;確認階段只會看下面的「候選」。`));
  }
  const shown = rows.slice(0, view.liveLimit);
  const body = h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, ['規則', '筆數', '保守勝率', '保守平均', '樂觀勝率', '樂觀平均', '個股達標', ''].map((x, i) => h('th', { class: i === 0 ? 'left' : '' }, x)))),
    h('tbody', null, shown.map((r) => h('tr', { style: r.key === selected ? { background: 'color-mix(in srgb, var(--s1) 10%, transparent)' } : null },
      h('td', { class: 'left' }, h('button', { type: 'button', class: 'link', onClick: () => onSelect(r.key) }, h('code', null, r.key))),
      h('td', null, fmtN(r.cons.n)), h('td', null, pct(r.cons.win, 1)), h('td', { class: signClass(r.cons.mean) }, pct(r.cons.mean, 2, { sign: true })),
      h('td', null, pct(r.opt.win, 1)), h('td', { class: signClass(r.opt.mean) }, pct(r.opt.mean, 2, { sign: true })),
      h('td', null, pct(r.cons.stockPass, 1)),
      h('td', null, h('button', { type: 'button', class: 'ghost', onClick: () => onSelect(r.key) }, '看明細')))))));
  const more = rows.length > shown.length ? h('button', { type: 'button', class: 'ghost', onClick: () => { view.liveLimit += 100; rerender(); } }, `再顯示 100 條(還有 ${rows.length - shown.length} 條)`) : null;
  return card(`存活候選(${rows.length} 條)`, {},
    h('p', { class: 'hint' }, `I1 的樂觀上界仍過 D1 與 D2 的規則,依保守平均由高到低。「存活」只代表上界過關,不代表合格:保守算法才是正式數字,還要通過下面的確認。`), body, more);
}

/** 一條規則: I1(掃描時就有)與確認階段的 I2、5 分 K(揭曉後才有) */
export function intradayDetailCard(row, confirm, t, ctx) {
  const rows = [statRow('I1 保守', row.cons, t, { note: '正式數字' }), statRow('I1 樂觀', row.opt, t, { note: '上界' })];
  if (confirm) {
    rows.push(statRow('I2 保守', confirm.i2, t), statRow('I2 樂觀', confirm.i2opt, t, { note: '上界' }), statRow('I2 兩倍成本', confirm.i2x2, t),
      statRow('5 分 K 保守', confirm.m5, t, { d3: false }), statRow('5 分 K 樂觀', confirm.m5opt, t, { d3: false, note: '上界' }));
  }
  const verdict = confirm ? verdictOf(confirm, t) : null;
  return card('規則明細', { actions: ctx.onClose ? h('button', { type: 'button', class: 'ghost', onClick: ctx.onClose }, '關閉') : null },
    h('div', { class: 'row wrap' }, h('code', null, row.key), ctx.live ? h('span', { class: 'tag' }, '存活候選') : null, verdict ? verdictBadge(verdict) : null),
    h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, STAT_HEAD, h('tbody', null, rows))),
    confirm ? h('p', { class: 'hint' }, verdict.reasons.length ? `不合格的原因: ${verdict.reasons.join('、')}` : '所有條件都通過。')
      : h('p', { class: 'hint' }, 'I2 與 5 分 K 還沒有揭曉(在下面的「確認」按下按鈕才會看)。'));
}

const CHECK_LABEL = {
  live: '不是存活候選(I1 樂觀上界沒過)', 'i2.D1': 'I2 勝率', 'i2.D2': 'I2 平均', 'i2.D3': 'I2 個股達標',
  'x2.D1': '兩倍成本勝率', 'x2.D2': '兩倍成本平均', 'm5.D1': '5 分 K 勝率', 'm5.D2': '5 分 K 平均',
};

/** 合格與否由引擎的 failedChecks 決定(和服務層算的是同一份),這裡只把沒通過的項目翻成文字。 */
export function verdictOf(c, t) {
  const failed = failedChecks(c, t);
  return { qualified: failed.length === 0, reasons: failed.map((k) => CHECK_LABEL[k]) };
}

const verdictBadge = (v) => badge(v.qualified, v.qualified ? '合格' : '不合格');

const short = (s) => `${pct(s.win, 1)} / ${pct(s.mean, 2, { sign: true })}`;

/**
 * 確認階段。揭曉前: 說明與按鈕;揭曉後: 每條規則的 I1 → I2 → 5 分 K 一覽與判定。
 * ctx: { keys, candidates, live, peeksText, canConfirm, whyNot, onConfirm, onSelect, progress, onCsv }
 */
export function confirmCard(scan, confirm, t, ctx) {
  const byKey = new Map(scan.rules.map((r) => [r.key, r]));
  const tagOf = (k) => [scan.live.includes(k) ? '存活' : null, ...Object.entries(scan.candidates).filter(([, v]) => v === k).map(([c]) => CAND_TAG[c])].filter(Boolean).join(' ');
  if (!confirm) {
    return card('確認(I2 與 5 分 K)', {},
      h('p', { class: 'hint' }, `確認階段只看「存活候選 + 候選」共 ${ctx.keys.length} 條規則: I2(60 分 K 的後半,沒被掃描用過)的保守、樂觀與兩倍成本,以及 5 分 K 的保守與樂觀。`),
      h('p', { class: 'hint' }, `合格 = 存活候選,且 I2 保守過 D1–D3、I2 兩倍成本過 D1 與 D2、5 分 K 保守過 D1 與 D2。`),
      h('div', { class: 'notice' }, ctx.peeksText),
      ctx.progress || null,
      h('div', null, h('button', { type: 'button', id: 'dt-confirm', disabled: !ctx.canConfirm, title: ctx.whyNot || '', onClick: ctx.onConfirm }, `揭曉 I2 與 5 分 K(${ctx.keys.length} 條)`)),
      ctx.whyNot ? h('p', { class: 'field-error' }, ctx.whyNot) : null);
  }
  const verdicts = confirm.rules.map((c) => ({ c, v: verdictOf(c, t) }));
  const nQ = verdicts.filter((x) => x.v.qualified).length;
  const head = ['規則', '判定', '類型', 'I1 保守', 'I2 保守', 'I2 樂觀', 'I2 兩倍成本', '5 分 K 保守', '5 分 K 樂觀'];      // 判定放前面: 窄螢幕要橫向捲動時最重要的欄位不會被藏起來
  return card(`確認結果: ${nQ} / ${confirm.rules.length} 條合格`, { actions: ctx.onCsv ? h('button', { type: 'button', class: 'ghost', onClick: ctx.onCsv }, '下載(CSV)') : null },
    h('p', { class: 'hint' }, `I2: ${confirm.i2.first} → ${confirm.i2.last}(${confirm.i2.days} 個交易日)· 5 分 K: ${confirm.m5.first} → ${confirm.m5.last}(${confirm.m5.days} 個交易日)。每格 = 勝率 / 平均每筆淨報酬。${ctx.peeksText}`),
    h('div', { class: 'tbl-wrap', style: { maxHeight: '560px' } }, h('table', { class: 'tbl', 'data-testid': 'dt-confirm-table' },
      h('thead', null, h('tr', null, head.map((x, i) => h('th', { class: i < 3 ? 'left' : '' }, x)))),
      h('tbody', null, verdicts.map(({ c, v }) => h('tr', { 'data-key': c.key, style: ctx.selected === c.key ? { background: 'color-mix(in srgb, var(--s1) 10%, transparent)' } : null },
        h('td', { class: 'left' }, h('button', { type: 'button', class: 'link', onClick: () => ctx.onSelect(c.key) }, h('code', null, c.key))),
        h('td', { class: 'left', title: v.reasons.join('、') }, verdictBadge(v)),
        h('td', { class: 'left' }, tagOf(c.key)),
        h('td', null, short(byKey.get(c.key).cons)), h('td', null, short(c.i2)), h('td', null, short(c.i2opt)), h('td', null, short(c.i2x2)), h('td', null, short(c.m5)), h('td', null, short(c.m5opt))))))),
    nQ === 0 ? h('p', { class: 'hint' }, '沒有規則通過確認。可以點規則名稱看是哪幾項沒過。這個結果本身就是答案 — 不要因為它去回頭調整規則,再用同一份 I2 驗證。') : null);
}

/** 確認結果的 CSV */
export function confirmCsv(scan, confirm, t) {
  const byKey = new Map(scan.rules.map((r) => [r.key, r]));
  const cols = [['i1', (c) => byKey.get(c.key).cons], ['i2', (c) => c.i2], ['i2_opt', (c) => c.i2opt], ['i2_2x_cost', (c) => c.i2x2], ['m5', (c) => c.m5], ['m5_opt', (c) => c.m5opt]];
  const head = ['rule', 'live', 'qualified', ...cols.flatMap(([n]) => [`${n}_n`, `${n}_win`, `${n}_mean`])];
  const esc = (v) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = confirm.rules.map((c) => [c.key, c.live, verdictOf(c, t).qualified, ...cols.flatMap(([, f]) => { const s = f(c); return [s.n, s.win, s.mean]; })]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}
