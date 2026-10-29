// 當沖掃描用的兩張 SVG 圖: 規則散佈圖(勝率 × 平均報酬)與單筆報酬分佈。
// 顏色全部用 CSS 變數(亮/暗色自動切換);每張圖旁邊都有同樣資料的表格,不靠顏色傳達資訊。

import { h } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  kids.forEach((c) => c && el.append(c));
  return el;
};

const niceStep = (span, target) => {
  const raw = span / target, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * mag;
};
const ticks = (lo, hi, target = 5) => {
  const step = niceStep(hi - lo, target), out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
};
const pctText = (v, d = 0) => `${(v * 100).toFixed(d)}%`;

/**
 * 勝率(橫)× 平均每筆淨報酬(縱)。目標區域(勝率與平均都過門檻)畫成淡色底。
 * points: [{ key, win, mean, n, series: 'cons' | 'opt' }]
 */
export function scatterChart(mount, points, { winTarget, meanTarget, selected = null, onSelect = () => {}, describe = () => '' } = {}) {
  const W = 680, H = 360, m = { l: 58, r: 16, t: 14, b: 40 };
  const xs = points.map((p) => p.win), ys = points.map((p) => p.mean);
  const xLo = Math.max(0, Math.min(0.3, ...xs) - 0.02), xHi = Math.min(1, Math.max(winTarget + 0.08, ...xs) + 0.02);
  let yLo = Math.min(-0.005, ...ys), yHi = Math.max(meanTarget * 1.5, ...ys);
  const pad = (yHi - yLo) * 0.06; yLo -= pad; yHi += pad;
  const sx = (v) => m.l + ((v - xLo) / (xHi - xLo)) * (W - m.l - m.r);
  const sy = (v) => H - m.b - ((v - yLo) / (yHi - yLo)) * (H - m.t - m.b);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '規則散佈圖: 橫軸勝率、縱軸平均每筆淨報酬;右上角是目標區域', style: 'display:block;max-height:380px' });
  // 格線與座標軸
  for (const t of ticks(xLo, xHi, 6)) {
    root.append(svg('line', { x1: sx(t), x2: sx(t), y1: m.t, y2: H - m.b, stroke: 'var(--grid)', 'stroke-width': 1 }),
      svg('text', { x: sx(t), y: H - m.b + 16, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 11 }, pctText(t)));
  }
  for (const t of ticks(yLo, yHi, 5)) {
    root.append(svg('line', { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), stroke: t === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }),
      svg('text', { x: m.l - 8, y: sy(t) + 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 11 }, pctText(t, Math.abs(t) < 0.01 && t !== 0 ? 1 : 1)));
  }
  root.append(svg('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 12 }, '勝率'),
    svg('text', { x: 14, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 12, transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})` }, '平均每筆淨報酬'));
  // 目標區域
  const tx = sx(winTarget), ty = sy(meanTarget);
  root.append(svg('rect', { x: tx, y: m.t, width: W - m.r - tx, height: ty - m.t, fill: 'var(--s3)', opacity: 0.12 }),
    svg('line', { x1: tx, x2: tx, y1: m.t, y2: H - m.b, stroke: 'var(--s3)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }),
    svg('line', { x1: m.l, x2: W - m.r, y1: ty, y2: ty, stroke: 'var(--s3)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }),
    svg('text', { x: W - m.r - 6, y: m.t + 14, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 11 }, `目標: 勝率 > ${pctText(winTarget)} 且平均 ≥ ${pctText(meanTarget, 1)}`));
  // 點: 樂觀(空心橘)先畫,保守(實心藍)在上層
  const draw = (series) => points.filter((p) => p.series === series).forEach((p) => {
    const isSel = p.key === selected;
    const el = series === 'cons'
      ? svg('circle', { cx: sx(p.win), cy: sy(p.mean), r: isSel ? 6 : 3.4, fill: 'var(--s1)', 'fill-opacity': 0.75, stroke: isSel ? 'var(--ink)' : 'var(--surface)', 'stroke-width': isSel ? 2 : 1 })
      : svg('circle', { cx: sx(p.win), cy: sy(p.mean), r: isSel ? 6 : 3.6, fill: 'none', stroke: 'var(--s2)', 'stroke-width': isSel ? 2.4 : 1.4, 'stroke-opacity': 0.9 });
    root.append(el);
  });
  draw('opt'); draw('cons');
  const hasOpt = points.some((p) => p.series === 'opt');

  const tip = h('div', { class: 'tip' });
  const box = h('div', { class: 'chart', style: { height: 'auto' } }, root, tip);
  const nearest = (evt) => {
    const r = root.getBoundingClientRect(), k = W / r.width;
    const px = (evt.clientX - r.left) * k, py = (evt.clientY - r.top) * k;
    let best = null, bd = 14 * 14;
    for (const p of points) {
      const d = (sx(p.win) - px) ** 2 + (sy(p.mean) - py) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  root.addEventListener('pointermove', (evt) => {
    const p = nearest(evt);
    if (!p) { tip.style.display = 'none'; return; }
    const r = box.getBoundingClientRect();
    tip.replaceChildren(h('div', { class: 't' }, p.series === 'cons' ? '保守(正式數字)' : '樂觀(上界)'), h('div', null, h('b', null, p.key)), h('div', null, describe(p)));
    tip.style.display = 'block';
    tip.style.left = `${Math.min(evt.clientX - r.left + 12, r.width - 200)}px`;
    tip.style.top = `${evt.clientY - r.top + 12}px`;
  });
  root.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  root.addEventListener('click', (evt) => { const p = nearest(evt); if (p) onSelect(p.key); });
  root.style.cursor = 'crosshair';

  mount.replaceChildren(box);
  return { hasOpt };
}

/** 單筆淨報酬分佈。hist = { lo, hi, bins, counts, under, over }。 */
export function histogramChart(mount, hist, { meanLine = null } = {}) {
  const W = 680, H = 200, m = { l: 48, r: 12, t: 10, b: 30 };
  const maxCount = Math.max(1, ...hist.counts, hist.under, hist.over);
  const n = hist.counts.length + 2;                                    // 左尾 + 各格 + 右尾
  const bw = (W - m.l - m.r) / n;
  const sy = (v) => H - m.b - (v / maxCount) * (H - m.t - m.b);
  const step = (hist.hi - hist.lo) / hist.bins;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': '每筆淨報酬的分佈', style: 'display:block;max-height:220px' });
  for (const t of ticks(0, maxCount, 4).filter(Number.isInteger)) {
    root.append(svg('line', { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), stroke: 'var(--grid)' }),
      svg('text', { x: m.l - 6, y: sy(t) + 4, 'text-anchor': 'end', fill: 'var(--ink-2)', 'font-size': 11 }, t >= 1000 ? `${(t / 1000).toFixed(t % 1000 ? 1 : 0)}k` : String(t)));
  }
  const bar = (i, count, lo) => root.append(svg('rect', {
    x: m.l + i * bw + 0.5, y: sy(count), width: Math.max(1, bw - 1), height: Math.max(0, H - m.b - sy(count)),
    fill: lo < 0 ? 'var(--bad)' : 'var(--s1)', opacity: 0.85, rx: 1,
  }, svg('title', {}, `${count.toLocaleString('en-US')} 筆`)));
  bar(0, hist.under, -1);
  hist.counts.forEach((c, k) => bar(k + 1, c, hist.lo + k * step + step / 2));
  bar(n - 1, hist.over, 1);
  const xAt = (v) => m.l + bw + ((v - hist.lo) / (hist.hi - hist.lo)) * (hist.bins * bw);
  for (const v of [hist.lo, hist.lo / 2, 0, hist.hi / 2, hist.hi]) {
    root.append(svg('text', { x: xAt(v), y: H - 10, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 11 }, `${(v * 100).toFixed(0)}%`));
  }
  root.append(svg('line', { x1: xAt(0), x2: xAt(0), y1: m.t, y2: H - m.b, stroke: 'var(--ink)', 'stroke-width': 1, opacity: 0.6 }));
  if (meanLine !== null && meanLine > hist.lo && meanLine < hist.hi) {
    root.append(svg('line', { x1: xAt(meanLine), x2: xAt(meanLine), y1: m.t, y2: H - m.b, stroke: 'var(--s2)', 'stroke-width': 2, 'stroke-dasharray': '4 3' }),
      svg('text', { x: xAt(meanLine) + 5, y: m.t + 12, fill: 'var(--ink-2)', 'font-size': 11 }, `平均 ${(meanLine * 100).toFixed(2)}%`));
  }
  root.append(svg('text', { x: m.l + bw / 2, y: H - 10, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 10 }, '<'), svg('text', { x: W - m.r - bw / 2, y: H - 10, 'text-anchor': 'middle', fill: 'var(--ink-2)', 'font-size': 10 }, '>'));
  mount.replaceChildren(root);
}
