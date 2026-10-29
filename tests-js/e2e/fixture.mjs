// 端對端測試用: 把 site/ 複製到暫存目錄,並寫入「合成」的價格資料(不是真實行情,名稱也都標明了)。
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { priceFileName } from '../../site/js/engine/data.js';

const SITE = fileURLToPath(new URL('../../site', import.meta.url));

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** weekdaysOnly=false 代表 24/7 的市場(加密貨幣) */
function series(id, { seed, n, start, vol = 0.014, drift = 0.0004, base = 100, weekdaysOnly = true }) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const out = { d: [], o: [], h: [], l: [], c: [], v: [] };
  let prev = base, t = Date.UTC(+start.slice(0, 4), +start.slice(5, 7) - 1, +start.slice(8, 10));
  while (out.d.length < n) {
    const day = new Date(t).getUTCDay();
    t += 86400000;
    if (weekdaysOnly && (day === 0 || day === 6)) continue;
    const open = prev * (1 + gauss() * vol * 0.25);
    const close = open * (1 + drift + gauss() * vol);
    const wick = Math.abs(gauss()) * vol * 0.5 * close;
    out.d.push(new Date(t - 86400000).toISOString().slice(0, 10));
    out.o.push(+open.toFixed(4)); out.h.push(+(Math.max(open, close) + wick).toFixed(4));
    out.l.push(+(Math.min(open, close) - wick).toFixed(4)); out.c.push(+close.toFixed(4)); out.v.push(1000000);
    prev = close;
  }
  return out;
}

export const ASSETS = [
  { id: 'SPY', name: 'SPDR S&P 500(合成測試資料)', category: '美股 ETF', cfg: { seed: 11, n: 2000, start: '2018-01-02', base: 270 } },
  { id: 'QQQ', name: 'Invesco QQQ(合成測試資料)', category: '美股 ETF', cfg: { seed: 12, n: 2000, start: '2018-01-02', base: 160, vol: 0.017 } },
  { id: 'GLD', name: 'SPDR Gold(合成測試資料)', category: '商品', cfg: { seed: 13, n: 2000, start: '2018-01-02', base: 120, vol: 0.009, drift: 0.0002 } },
  { id: 'TLT', name: 'iShares 20Y Treasury(合成測試資料)', category: '債券', cfg: { seed: 14, n: 1500, start: '2020-01-02', base: 130, vol: 0.008, drift: -0.0001 } },
  { id: 'BTC-USD', name: 'Bitcoin(合成測試資料)', category: '加密貨幣', cfg: { seed: 15, n: 2800, start: '2018-01-01', base: 10000, vol: 0.035, drift: 0.0012, weekdaysOnly: false } },
  { id: '^IRX', name: '13 週國庫券利率(合成測試資料)', category: '指數', cfg: { seed: 17, n: 2000, start: '2018-01-02', base: 4, vol: 0.004, drift: 0 } },
  { id: '^VIX', name: 'VIX 波動率指數(合成測試資料)', category: '指數', cfg: { seed: 16, n: 2000, start: '2018-01-02', base: 20, vol: 0.06, drift: 0 } },
];

export function buildSite({ withData = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'strategy-lab-'));
  cpSync(SITE, dir, { recursive: true });
  if (withData) {
    mkdirSync(join(dir, 'data', 'prices'), { recursive: true });
    const assets = ASSETS.map(({ id, name, category, cfg }) => {
      const s = series(id, cfg);
      writeFileSync(join(dir, 'data', 'prices', `${priceFileName(id)}.json`), JSON.stringify({ symbol: id, ...s }));
      return { id, name, category, first: s.d[0], last: s.d.at(-1), n: s.d.length };
    });
    writeFileSync(join(dir, 'data', 'universe.json'), JSON.stringify({ updated: '2026-10-29(測試資料)', assets }));
  }
  return dir;
}

/**
 * 假的 Yahoo(給 /api 注入 fetchImpl 用;不連網,資料是合成的): 每個代號一條亂數行情,最後一根在三天前。
 * 特殊代號: ZZZZ = 找不到(404)、LIMIT = 限流(429)、STALE = 收盤價疑似過期(會被品質檢查拒絕)、SHORT = 只有 60 根。
 */
export function mockYahoo() {
  const calls = [];
  const hash = (s) => [...s].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0, 7);
  function chart(symbol) {
    const rand = rng(hash(symbol)), gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const n = symbol === 'SHORT' ? 60 : 800;
    const ts = [], o = [], h = [], l = [], c = [], v = [];
    const end = Date.now() - 3 * 86400000;
    const days = [];
    for (let t = end; days.length < n; t -= 86400000) { const d = new Date(t).getUTCDay(); if (d !== 0 && d !== 6) days.push(t); }
    days.reverse();
    let price = 50 + rand() * 200;
    days.forEach((t, i) => {
      const op = price, cl = symbol === 'STALE' && i % 2 === 0 ? op : op * (1 + 0.0004 + 0.014 * gauss());
      ts.push(Math.floor(t / 1000)); o.push(+op.toFixed(4)); c.push(+cl.toFixed(4));
      h.push(+(Math.max(op, cl) * 1.004).toFixed(4)); l.push(+(Math.min(op, cl) * 0.996).toFixed(4)); v.push(1000000 + i);
      price = cl;
    });
    return { chart: { error: null, result: [{ meta: { gmtoffset: 0, symbol, shortName: `${symbol} Inc.`, currency: 'USD', fullExchangeName: 'NasdaqGS', instrumentType: 'EQUITY' }, timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }], adjclose: [{ adjclose: c }] } }] } };
  }
  const fetchImpl = async (url) => {
    const u = new URL(String(url));
    calls.push(String(url));
    const reply = (status, body) => ({ status, json: async () => body });
    if (u.pathname.startsWith('/v1/finance/search')) {
      const q = (u.searchParams.get('q') || '').toLowerCase();
      const quotes = q.includes('apple') ? [{ symbol: 'AAPL', quoteType: 'EQUITY', longname: 'Apple Inc.', exchDisp: 'NASDAQ' }, { symbol: 'AAPL.MX', quoteType: 'EQUITY', shortname: 'APPLE INC.', exchDisp: 'Mexico' }]
        : q.includes('tesla') ? [{ symbol: 'TSLA', quoteType: 'EQUITY', longname: 'Tesla, Inc.', exchDisp: 'NASDAQ' }] : [];
      return reply(200, { quotes });
    }
    const symbol = decodeURIComponent(u.pathname.split('/').pop());
    if (symbol === 'ZZZZ') return reply(404, { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } });
    if (symbol === 'LIMIT') return reply(429, null);
    return reply(200, chart(symbol));
  };
  return { fetchImpl, calls };
}
