// 本機伺服器的 /api/py: 在網站的回測裡執行「用 Python 寫的策略」(資料夾 strategies_py/ 裡的 .py 檔)。
//   GET  /api/py/health      → { available, python, pandas, numpy, dir, reason }
//   GET  /api/py/strategies  → [{ id, file, name, doc, params:[{name,value}], error? }]
//   POST /api/py/run         → body { id, params, bars:{d,o,h,l,c,v}, check_lookahead } → 訊號(見 tools/py_runner.py)
// 策略是「你自己的程式碼」,以你的身分執行(和你自己在終端機跑 python 一樣):只會執行 strategies_py/ 裡的檔案,
// 不要把來路不明的檔案放進去。每次執行是獨立的子行程,有逾時,同時最多跑 2 個。

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./py_runner.py', import.meta.url));
export const ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
const MAX_OUTPUT = 200 * 1024 * 1024;

/** 執行一個指令,回傳 { code, stdout, stderr, timedOut }。 */
function exec(cmd, args, { input = null, timeoutMs = 30000, cwd, env } = {}) {
  return new Promise((resolveP) => {
    let child;
    try { child = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', ...env }, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolveP({ code: -1, stdout: '', stderr: String(e), spawnError: true }); return; }
    const out = [], err = [];
    let size = 0, timedOut = false, done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolveP(r); } };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (b) => { size += b.length; if (size > MAX_OUTPUT) { child.kill('SIGKILL'); } else out.push(b); });
    child.stderr.on('data', (b) => { if (err.length < 200) err.push(b); });
    child.on('error', (e) => finish({ code: -1, stdout: '', stderr: String(e), spawnError: true }));
    child.on('close', (code) => finish({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut }));
    child.stdin.on('error', () => {});                                  // 子行程提早結束時寫入會 EPIPE
    child.stdin.end(input ?? undefined);
  });
}

export function createPy({ dir, python = process.env.STRATEGY_LAB_PYTHON || '', timeoutMs = 120000, maxParallel = 2 } = {}) {
  const folder = dir ? resolve(dir) : null;
  let detected = null;                                                    // { cmd, args, version, pandas, numpy }
  let running = 0;
  const waiting = [];

  async function detect() {
    if (detected) return detected;
    const candidates = python ? [[python, []]] : [['python3', []], ['python', []], ['py', ['-3']]];
    for (const [cmd, pre] of candidates) {
      const r = await exec(cmd, [...pre, '-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs: 15000 });
      if (r.code !== 0) continue;
      const lib = await exec(cmd, [...pre, '-c', 'import pandas, numpy;print(pandas.__version__, numpy.__version__)'], { timeoutMs: 60000 });
      const [pandas, numpy] = lib.code === 0 ? lib.stdout.trim().split(' ') : [null, null];
      detected = { cmd, args: pre, version: r.stdout.trim(), pandas, numpy };
      return detected;
    }
    detected = { cmd: null, args: [], version: null, pandas: null, numpy: null };
    return detected;
  }

  const slot = async () => {
    if (running >= maxParallel) await new Promise((r) => waiting.push(r));
    running++;
    return () => { running--; waiting.shift()?.(); };
  };

  async function health() {
    if (!folder) return { available: false, reason: '這個伺服器沒有設定策略資料夾' };
    const d = await detect();
    const base = { dir: folder, folderExists: existsSync(folder) && statSync(folder).isDirectory(), python: d.version, pandas: d.pandas, numpy: d.numpy };
    if (!d.cmd) return { ...base, available: false, reason: '找不到 Python(試過 python3、python、py)。請安裝 Python 3,或設定環境變數 STRATEGY_LAB_PYTHON 指向 python 執行檔。' };
    if (!d.pandas) return { ...base, available: false, reason: '需要 pandas 與 numpy: pip install pandas numpy' };
    if (!base.folderExists) return { ...base, available: false, reason: `找不到策略資料夾 ${folder}` };
    return { ...base, available: true };
  }

  /** 呼叫 py_runner.py,回傳它印出的 JSON(失敗時 { ok:false, error })。 */
  async function call(args, input, timeout = timeoutMs) {
    const h = await health();
    if (!h.available) return { ok: false, error: h.reason, status: 503 };
    const d = await detect();
    const release = await slot();
    try {
      const r = await exec(d.cmd, [...d.args, RUNNER, ...args], { input, timeoutMs: timeout, cwd: folder });
      if (r.timedOut) return { ok: false, error: `策略執行超過 ${Math.round(timeout / 1000)} 秒,已中止`, status: 504 };
      try { return JSON.parse(r.stdout); } catch {
        return { ok: false, error: `Python 沒有回傳正確的結果(結束碼 ${r.code})。${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' / ').slice(0, 600)}`, status: 500 };
      }
    } finally { release(); }
  }

  async function list() {
    const r = await call(['list', folder], null, 60000);
    return r.ok ? { ok: true, strategies: r.strategies } : r;
  }

  async function run(body) {
    if (!body || typeof body !== 'object' || !ID_RE.test(String(body.id || ''))) return { ok: false, error: '策略 id 不正確(只能用英數字、底線與連字號)', status: 400 };
    const b = body.bars;
    if (!b || !Array.isArray(b.d) || ['o', 'h', 'l', 'c'].some((k) => !Array.isArray(b[k]) || b[k].length !== b.d.length)) return { ok: false, error: '資料格式不正確(需要等長的 d / o / h / l / c 陣列)', status: 400 };
    if (b.d.length > 200000) return { ok: false, error: '資料太長(最多 200,000 根)', status: 400 };
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
    const r = await call(['run', folder, body.id], JSON.stringify({ bars: b, params, check_lookahead: body.check_lookahead !== false }));
    if (!r.ok && !r.status) r.status = 422;                            // 策略本身的問題(格式不對、執行出錯)
    return r;
  }

  return { health, list, run, detect, dir: folder };
}
