// 盤中服務層: 載入 → I1 掃描 → 確認(I2 與 5 分 K),結果與使用者的 Python 程序相同;I2 / 5 分 K 在掃描時不會洩漏。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { standardGrid } from '../site/js/engine/daytrade.js';
import { createService } from '../site/js/engine/dtService.js';

const fx = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const buf = (name) => { const b = fx(name); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const golden = JSON.parse(fx('intraday_golden.json').toString('utf8'));
const unpack = (packed) => Object.fromEntries(golden.fields.map((f, i) => [{ avg_win: 'avgWin', avg_loss: 'avgLoss', day_mean: 'dayMean', stock_pass: 'stockPass' }[f] || f, packed[i]]));
const grid = standardGrid();

async function loaded({ five = true } = {}) {
  const svc = createService();
  await svc.loadNpz({ buffer: buf('daytrade_panel.npz') });
  await svc.loadIntraday({ buffer: buf('intraday_60m.npz'), interval: '60m' });
  if (five) await svc.loadIntraday({ buffer: buf('intraday_5m.npz'), interval: '5m' });
  return svc;
}

test('載入: 回報天數、略過的日期、對上的標的數;可以先載入盤中檔再載入面板', async () => {
  const svc = await loaded();
  const info = svc.intradayInfo();
  assert.equal(info['60m'].bars, 7); assert.equal(info['60m'].tickers, 14); assert.equal(info['60m'].fileDays, 163);
  assert.equal(info['60m'].days, 161); assert.equal(info['60m'].skipped, 2); assert.equal(info['60m'].matched, 14); assert.equal(info['60m'].aligned, true);
  assert.equal(info['5m'].bars, 78); assert.equal(info['5m'].days, 45);
  assert.equal(info['60m'].firstUsed, golden.dates60[0]);

  const early = createService();
  const pre = await early.loadIntraday({ buffer: buf('intraday_60m.npz'), interval: '60m' });
  assert.equal(pre.aligned, false);
  assert.equal(pre.fileDays, 163);
  await early.loadNpz({ buffer: buf('daytrade_panel.npz') });
  assert.equal(early.intradayInfo()['60m'].days, 161, '面板載入後才對齊');
  assert.equal(early.intradayInfo()['5m'], null);
});

test('載入: 檔數對不起來的盤中檔在載入時就拒絕,原本載入的不受影響', async () => {
  const svc = await loaded({ five: false });
  const before = svc.intradayInfo()['60m'];
  const small = buf('intraday_ok_small.npz');                 // 兩檔、有代號 A B,面板沒有這兩個代號
  const out = await svc.loadIntraday({ buffer: small, interval: '5m' }).catch((e) => e);
  assert.ok(out instanceof Error && /沒有任何交集/.test(out.message), String(out));
  assert.deepEqual(svc.intradayInfo()['60m'], before);
  assert.equal(svc.intradayInfo()['5m'], null, '失敗的檔案不會留下');
  await assert.rejects(svc.loadIntraday({ buffer: buf('intraday_60m.npz'), interval: '15m' }), /未知的盤中檔種類/);
});

test('I1 掃描: 與 Python 相同,只含 I1,存活候選與候選一致', async () => {
  const svc = await loaded({ five: false });
  const progress = [];
  const out = svc.scanIntraday({ grid }, (d, t) => progress.push([d, t]));
  assert.equal(out.rules.length, 588);
  assert.deepEqual(progress.at(-1), [14, 14]);
  const py = golden.protocols.strict;
  assert.deepEqual([out.dev.first, out.dev.last], py.i1_range);
  assert.deepEqual([out.i2.first, out.i2.last], py.i2_range);
  assert.equal(out.dev.days + out.i2.days, 161);
  out.rules.forEach((r, i) => {
    const g = golden.rules[i];
    assert.equal(r.key, g.rule);
    assert.equal(r.cons.n, unpack(g.i1).n); assert.equal(r.opt.n, unpack(g.i1_opt).n);
    assert.ok(Math.abs(r.cons.mean - unpack(g.i1).mean) < 1e-12);
  });
  assert.deepEqual(out.live, py.live);
  assert.deepEqual(out.candidates, py.candidates);
  // 放寬的門檻
  const loose = svc.scanIntraday({ grid, thresholds: { winThreshold: 0.6, meanThreshold: 0.002 } });
  assert.deepEqual(loose.live, golden.protocols.loose.live);
  assert.deepEqual(loose.candidates, golden.protocols.loose.candidates);
});

/** 最小的 .npz 寫入器(zip 不壓縮、CRC 填 0 — 我們的讀取器不檢查),只給測試用: arrays = { 名稱: { descr, shape, data } } */
function makeNpz(arrays) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  const u16 = (v) => Uint8Array.of(v & 255, (v >> 8) & 255), u32 = (v) => Uint8Array.of(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const cat = (...xs) => { const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { out.set(x, o); o += x.length; } return out; };
  for (const [name, { descr, shape, data }] of Object.entries(arrays)) {
    let header = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`;
    while ((10 + header.length + 1) % 64) header += ' ';
    header += '\n';
    const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const npy = cat(Uint8Array.of(0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0), u16(header.length), enc.encode(header), body);
    const fname = enc.encode(`${name}.npy`);
    const local = cat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(npy.length), u32(npy.length), u16(fname.length), u16(0), fname, npy);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0), u32(npy.length), u32(npy.length), u16(fname.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), fname));
    parts.push(local); offset += local.length;
  }
  const cd = cat(...central);
  const out = cat(...parts, cd, u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(offset), u16(0));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

test('I1 掃描不會碰到 I2 與 5 分 K: 把 I2 那一半的 K 棒全部改掉,I1 掃描結果一模一樣,確認階段的結果則會跟著變', async () => {
  const { readNpz } = await import('../site/js/engine/npz.js');
  const z = await readNpz(buf('intraday_60m.npz'));
  const firstI2 = golden.dates60[golden.half];
  const days = z.dates.data.length, perDayHL = z.H.shape[1] * z.H.shape[2], perDayOC = z.O.shape[1];
  const H = Float32Array.from(z.H.data), L = Float32Array.from(z.L.data), O = Float32Array.from(z.O.data), C = Float32Array.from(z.C.data);
  let changedDays = 0;
  for (let f = 0; f < days; f++) {
    if (z.dates.data[f] < firstI2) continue;
    changedDays++;
    for (let i = f * perDayHL; i < (f + 1) * perDayHL; i++) { H[i] *= 1.3; L[i] *= 0.7; }
    for (let i = f * perDayOC; i < (f + 1) * perDayOC; i++) { O[i] *= 1.1; C[i] *= 0.9; }
  }
  assert.ok(changedDays >= 80);
  const dates = BigInt64Array.from(z.dates.data, (d) => BigInt(Date.parse(d) / 86400000));
  const altered = makeNpz({
    dates: { descr: '<M8[D]', shape: [days], data: dates },
    H: { descr: '<f4', shape: z.H.shape, data: H }, L: { descr: '<f4', shape: z.L.shape, data: L },
    O: { descr: '<f4', shape: z.O.shape, data: O }, C: { descr: '<f4', shape: z.C.shape, data: C },
  });

  const original = await loaded();
  const svc = createService();
  await svc.loadNpz({ buffer: buf('daytrade_panel.npz') });
  await svc.loadIntraday({ buffer: altered, interval: '60m' });
  await svc.loadIntraday({ buffer: buf('intraday_5m.npz'), interval: '5m' });

  const a = original.scanIntraday({ grid }), b = svc.scanIntraday({ grid });
  assert.deepEqual(b.rules.map((r) => [r.cons, r.opt]), a.rules.map((r) => [r.cons, r.opt]), 'I1 的結果與 I2 的資料無關');
  assert.deepEqual(b.live, a.live); assert.deepEqual(b.candidates, a.candidates);
  assert.ok(Object.keys(a).every((k) => !/confirm|m5/.test(k)), '掃描結果裡沒有確認階段的欄位');
  assert.ok(a.rules.every((r) => Object.keys(r).every((k) => ['key', 'side', 'setup', 'entry', 'exit', 'cons', 'opt'].includes(k))));

  const keys = a.live.slice(0, 20);
  const c1 = original.confirmIntraday({ grid, keys, live: a.live }), c2 = svc.confirmIntraday({ grid, keys, live: a.live });
  assert.ok(c2.rules.some((r, i) => r.i2.mean !== c1.rules[i].i2.mean), '改過的資料確實會讓 I2 的結果不同(這個測試不是空轉)');
  assert.deepEqual(c2.rules.map((r) => r.m5), c1.rules.map((r) => r.m5), '5 分 K 沒有動,結果不變');
});

for (const tag of ['strict', 'loose']) {
  test(`確認階段(${tag === 'strict' ? '他的原始門檻' : '放寬的門檻'}): I2 與 5 分 K 的統計與合格判定和 run_daytrade.py --confirm 相同`, async () => {
    const svc = await loaded();
    const py = golden.protocols[tag];
    const thresholds = tag === 'loose' ? { winThreshold: 0.6, meanThreshold: 0.002 } : undefined;
    const scan = svc.scanIntraday({ grid, thresholds });
    const progress = [];
    const out = svc.confirmIntraday({ grid, thresholds, live: scan.live, candidates: scan.candidates }, (d, t) => progress.push([d, t]));
    assert.deepEqual(out.rules.map((r) => r.key), py.confirm_order);
    assert.deepEqual(progress.at(-1), [28, 28], '進度條從 60 分 K 走到 5 分 K');
    for (const r of out.rules) {
      const want = py.confirm[r.key];
      assert.equal(r.live, want.live, `${r.key} live`);
      assert.equal(r.qualified, want.qualified, `${r.key} 合格`);
      for (const [mine, theirs] of [['i2', 'i2'], ['i2opt', 'i2_opt'], ['i2x2', 'i2_2x'], ['m5', 'm5'], ['m5opt', 'm5_opt']]) {
        const w = unpack(want[theirs]);
        assert.equal(r[mine].n, w.n, `${r.key} ${mine} n`);
        assert.ok(Math.abs(r[mine].win - w.win) < 1e-12 && Math.abs(r[mine].mean - w.mean) < 1e-12, `${r.key} ${mine}`);
      }
    }
    assert.deepEqual([out.i2.first, out.i2.last], py.i2_range);
    assert.equal(out.m5.days, 45);
    assert.equal(out.rules.filter((r) => r.qualified).length, Object.values(py.confirm).filter((c) => c.qualified).length);
  });
}

test('確認階段: 沒有 5 分 K 檔、沒有可確認的規則、規則不存在時都有清楚的錯誤', async () => {
  const noFive = await loaded({ five: false });
  const scan = noFive.scanIntraday({ grid });
  assert.throws(() => noFive.confirmIntraday({ grid, live: scan.live, candidates: scan.candidates }), /還沒有載入 5 分 K 檔/);
  const svc = await loaded();
  assert.throws(() => svc.confirmIntraday({ grid, live: [], candidates: {} }), /沒有可以確認的規則/);
  assert.throws(() => svc.confirmIntraday({ grid, keys: ['long|nope|open|close'] }), /找不到規則/);
  const fresh = createService();
  assert.throws(() => fresh.scanIntraday({ grid }), /還沒有載入資料/);
  const noIntra = createService();
  await noIntra.loadNpz({ buffer: buf('daytrade_panel.npz') });
  assert.throws(() => noIntra.scanIntraday({ grid }), /還沒有載入 60 分 K 檔/);
});

test('面板換了: 盤中檔重新對齊(舊的對齊結果不會殘留)', async () => {
  const svc = await loaded({ five: false });
  const first = svc.scanIntraday({ grid }).rules[0].cons;
  await svc.loadNpz({ buffer: buf('daytrade_panel_gaps.npz') });
  const again = svc.scanIntraday({ grid });
  assert.equal(again.rules.length, 588);
  assert.ok(first);
  assert.equal(svc.intradayInfo()['60m'].aligned, true);
});
