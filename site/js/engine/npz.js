// 讀 numpy 的 .npz(np.savez / np.savez_compressed 的輸出):一個 zip,裡面每個檔案是一個 .npy 陣列。
// 用來直接載入使用者研究程式產生的面板(例如 cache/sp500_daily.npz),不需要先轉檔。
// 只支援這種資料用得到的格式: 小端的 float32/float64/int/datetime64/unicode 陣列,C 順序。

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));

const LIMITS = { entries: 64, bytes: 1.5 * 1024 ** 3 };

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('這個瀏覽器不支援解壓縮(需要較新的 Chrome / Edge / Firefox / Safari)');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 解開 zip,回傳 { 檔名: Uint8Array }。 */
export async function unzip(buffer) {
  const dv = new DataView(buffer), bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 22 - 65535); i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 .npz(找不到 zip 目錄)');
  let count = u16(dv, eocd + 10), cdOffset = u32(dv, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;                                           // zip64 end-of-central-directory locator
    if (loc < 0 || u32(dv, loc) !== 0x07064b50) throw new Error('不是有效的 .npz(zip64 目錄損毀)');
    const z64 = u64(dv, loc + 8);
    count = u64(dv, z64 + 32); cdOffset = u64(dv, z64 + 48);
  }
  if (count > LIMITS.entries) throw new Error(`.npz 裡的陣列太多(${count} 個)`);

  const out = {};
  let p = cdOffset;
  for (let e = 0; e < count; e++) {
    if (u32(dv, p) !== 0x02014b50) throw new Error('不是有效的 .npz(zip 目錄損毀)');
    const method = u16(dv, p + 10);
    let csize = u32(dv, p + 20), usize = u32(dv, p + 24), local = u32(dv, p + 42);
    const nameLen = u16(dv, p + 28), extraLen = u16(dv, p + 30), commentLen = u16(dv, p + 32);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // zip64 擴充欄位: 只有值被填成 0xFFFFFFFF 的欄位才會出現在這裡,順序固定
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = u16(dv, x), size = u16(dv, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = u64(dv, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(dv, q); q += 8; }
        if (local === 0xffffffff) { local = u64(dv, q); }
      }
      x += 4 + size;
    }
    if (usize > LIMITS.bytes || csize > LIMITS.bytes) throw new Error(`.npz 裡的「${name}」太大`);
    if (u32(dv, local) !== 0x04034b50) throw new Error('不是有效的 .npz(找不到資料區)');
    const dataStart = local + 30 + u16(dv, local + 26) + u16(dv, local + 28);
    const raw = bytes.subarray(dataStart, dataStart + csize);
    if (method === 0) out[name] = raw.slice();
    else if (method === 8) out[name] = await inflateRaw(raw);
    else throw new Error(`.npz 使用了不支援的壓縮方式(${method})`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const TYPED = { '<f4': Float32Array, '<f8': Float64Array, '<i4': Int32Array, '<u4': Uint32Array, '<i2': Int16Array, '<u2': Uint16Array, '|u1': Uint8Array, '|i1': Int8Array };

/** 解析一個 .npy。回傳 { dtype, shape, data }: 數值是 TypedArray;日期是 'YYYY-MM-DD' 字串陣列;文字是 string[]。 */
export function parseNpy(u8) {
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  if (!magic.every((b, i) => u8[i] === b)) throw new Error('不是 .npy 陣列');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const major = u8[6];
  const headerLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const start = major === 1 ? 10 : 12;
  const header = new TextDecoder(major >= 3 ? 'utf-8' : 'latin1').decode(u8.subarray(start, start + headerLen));
  const descr = /'descr'\s*:\s*'([^']+)'/.exec(header)?.[1];
  const fortran = /'fortran_order'\s*:\s*(True|False)/.exec(header)?.[1] === 'True';
  const shapeText = /'shape'\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  if (!descr || shapeText === undefined) throw new Error('.npy 標頭無法解析');
  if (fortran) throw new Error('不支援 Fortran 順序的陣列(請用 C 順序存檔)');
  const shape = shapeText.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  const size = shape.reduce((a, b) => a * b, 1);
  const body = u8.slice(start + headerLen);                          // 複製一份,確保對齊
  const buf = body.buffer;

  if (TYPED[descr]) return { dtype: descr, shape, data: new TYPED[descr](buf, 0, size) };
  if (descr === '<i8' || descr === '<u8') {
    const big = descr === '<i8' ? new BigInt64Array(buf, 0, size) : new BigUint64Array(buf, 0, size);
    return { dtype: descr, shape, data: Float64Array.from(big, Number) };
  }
  const dt = /^<M8\[(D|s|ms|us|ns)\]$/.exec(descr);
  if (dt) {
    const ticksPerDay = { D: 1, s: 86400, ms: 86400e3, us: 86400e6, ns: 86400e9 }[dt[1]];
    const raw = new BigInt64Array(buf, 0, size);
    const days = Array.from(raw, (v) => Math.floor(Number(v) / ticksPerDay));
    return { dtype: descr, shape, data: days.map((d) => new Date(d * 86400000).toISOString().slice(0, 10)) };
  }
  const uni = /^<U(\d+)$/.exec(descr);
  if (uni) {
    const w = Number(uni[1]), codes = new Uint32Array(buf, 0, size * w), out = [];
    for (let i = 0; i < size; i++) {
      let s = '';
      for (let j = 0; j < w; j++) { const c = codes[i * w + j]; if (!c) break; s += String.fromCodePoint(c); }
      out.push(s);
    }
    return { dtype: descr, shape, data: out };
  }
  throw new Error(`不支援的 .npy 資料型態「${descr}」`);
}

/** 讀整個 .npz: { 名稱: { dtype, shape, data } }(名稱不含 .npy)。 */
export async function readNpz(buffer) {
  const files = await unzip(buffer);
  return Object.fromEntries(Object.entries(files).filter(([name]) => name.endsWith('.npy')).map(([name, u8]) => [name.replace(/\.npy$/, ''), parseNpy(u8)]));
}

/**
 * 把使用者研究程式的面板檔(cache/sp500_daily.npz)轉成引擎用的面板。
 * 期待欄位: dates (日,)、tickers (檔,)、Open / High / Low / Close (日, 檔),選用 vix (日,)。
 */
export async function panelFromNpz(buffer) {
  const z = await readNpz(buffer);
  const need = ['dates', 'tickers', 'Open', 'High', 'Low', 'Close'];
  const missing = need.filter((k) => !z[k]);
  if (missing.length) throw new Error(`.npz 缺少陣列: ${missing.join('、')}(需要 dates、tickers、Open、High、Low、Close)`);
  const dates = z.dates.data, tickers = z.tickers.data, n = dates.length, m = tickers.length;
  for (const k of ['Open', 'High', 'Low', 'Close']) {
    const { shape } = z[k];
    if (shape.length !== 2 || shape[0] !== n || shape[1] !== m) throw new Error(`${k} 的形狀應該是 (${n}, ${m}),實際是 (${shape.join(', ')})`);
  }
  const column = (name) => {
    const src = z[name].data, cols = [];
    for (let k = 0; k < m; k++) {
      const col = new Float32Array(n);
      for (let i = 0; i < n; i++) col[i] = src[i * m + k];
      cols.push(col);
    }
    return cols;
  };
  const panel = { dates, tickers, o: column('Open'), h: column('High'), l: column('Low'), c: column('Close'), aux: {} };
  if (z.vix && z.vix.data.length === n) panel.aux['^VIX'] = Float64Array.from(z.vix.data);
  return panel;
}

/**
 * 盤中 K 線檔(研究程式 build_intraday() 的輸出,例如 cache/sp500_60m.npz、sp500_5m.npz)。
 * 期待欄位: dates (日,)、H / L (日, 第幾根, 檔)、O / C (日, 檔),選用 tickers (檔,)。
 * H / L 是每根 K 棒的高低,O / C 是當天的開盤(第一根的開)與收盤(最後一根的收);缺值是 NaN。
 * 他的檔案沒有存代號,檔的順序要和日線面板一樣;有 tickers 欄位時改用代號對齊。
 */
export async function intradayFromNpz(buffer) {
  const z = await readNpz(buffer);
  const missing = ['dates', 'H', 'L', 'O', 'C'].filter((k) => !z[k]);
  if (missing.length) throw new Error(`.npz 缺少陣列: ${missing.join('、')}(盤中檔需要 dates、H、L、O、C)`);
  const dates = z.dates.data, n = dates.length;
  const { shape } = z.H;
  if (shape.length !== 3 || shape[0] !== n) throw new Error(`H 的形狀應該是 (${n}, 第幾根, 檔數),實際是 (${shape.join(', ')})`);
  const nb = shape[1], m = shape[2];
  if (nb < 1 || m < 1) throw new Error('H 的形狀不正確(沒有 K 棒或沒有標的)');
  if (z.L.shape.join() !== shape.join()) throw new Error(`L 的形狀 (${z.L.shape.join(', ')}) 與 H (${shape.join(', ')}) 不同`);
  for (const k of ['O', 'C']) {
    const sh = z[k].shape;
    if (sh.length !== 2 || sh[0] !== n || sh[1] !== m) throw new Error(`${k} 的形狀應該是 (${n}, ${m}),實際是 (${sh.join(', ')})`);
  }
  if (z.tickers && z.tickers.data.length !== m) throw new Error(`tickers 有 ${z.tickers.data.length} 檔,但 H 有 ${m} 檔`);
  for (let i = 1; i < n; i++) if (!(dates[i] > dates[i - 1])) throw new Error(`dates 必須由舊到新、不可重複(第 ${i + 1} 筆 ${dates[i]})`);
  return { dates, nb, m, H: z.H.data, L: z.L.data, O: z.O.data, C: z.C.data, tickers: z.tickers ? z.tickers.data : null };
}
