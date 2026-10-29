// 本機伺服器:  node tools/serve.mjs site 8080
// 提供網站的靜態檔案,以及 /api(輸入代號自動從 Yahoo 抓價格,見 tools/api.mjs)。只聽 127.0.0.1。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi } from './api.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

/** api: 不給 = 純靜態(沒有 /api);給物件(createApi 的選項,可以是 {})= 啟用 /api。 */
export function startServer(root, port = 0, { api = null } = {}) {
  const base = resolve(root);
  const apiHandler = api ? createApi(api) : null;
  const server = createServer(async (req, res) => {
    try {
      if (apiHandler && await apiHandler.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      let file = resolve(join(base, rel));
      if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403).end('forbidden'); return; }
      const info = await stat(file).catch(() => null);
      if (info?.isDirectory()) file = join(file, 'index.html');
      let body = await readFile(file);
      // 啟用 /api 時在首頁加一個標記: 網站看到標記才會去問 /api/health(純靜態託管沒有標記,就不會多送一個 404 的請求)
      if (apiHandler && file.endsWith(`${sep}index.html`)) body = Buffer.from(body.toString('utf8').replace('</head>', '  <meta name="strategy-lab-api" content="1">\n</head>'));
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // node tools/serve.mjs [網站資料夾] [埠號] [--strategies 策略資料夾] [--python python 執行檔]
  const args = process.argv.slice(2), flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const strategies = flag('--strategies'), python = flag('--python');
  const [root = 'site', port = '8080'] = args;
  const dir = strategies || process.env.STRATEGY_LAB_STRATEGIES || fileURLToPath(new URL('../strategies_py', import.meta.url));
  const server = await startServer(root, Number(port), { api: { py: { dir, ...(python ? { python } : {}) } } });
  console.log(`serving ${resolve(root)} at http://127.0.0.1:${server.address().port}/`);
  console.log('輸入代號自動抓價格已啟用(資料來自 Yahoo Finance,需要網路)。');
  console.log(`Python 策略資料夾: ${dir}(把用 Python 寫的策略放在這裡,見 README「用 Python 寫策略」)。按 Ctrl+C 結束。`);
}
