"""用 Python 版(tools/fetch_prices.py)對一批真實代號抓價格、清理,寫成 JSON,給 tools/live_check.mjs 對照。

    python tools/live_dump_python.py /tmp/py.json SPY AAPL ^GSPC ...
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools import fetch_prices as fp  # noqa: E402

out, symbols = sys.argv[1], sys.argv[2:]
session, now, dump = requests.Session(), datetime.now(timezone.utc), {}
for sym in symbols:
    try:
        raw = fp.fetch_chart(session, sym, 26, now)
        parsed = fp.parse_chart(raw)
        today_local = datetime.fromtimestamp(now.timestamp() + parsed["offset"], tz=timezone.utc).strftime("%Y-%m-%d")
        series, stats = fp.build_series(parsed, today_local)
        ok, warn, reason = fp.verdict(series, stats, today_local)
        dump[sym] = {"raw": raw, "today_local": today_local, "series": series, "stats": stats, "ok": ok, "warn": warn, "reason": reason}
        print(f"{sym}: n={stats['n']} ok={ok} {series['d'][0]}~{series['d'][-1]}")
    except Exception as e:  # noqa: BLE001
        dump[sym] = {"fetch_error": str(e)}
        print(f"{sym}: 抓取失敗 {e}")
Path(out).write_text(json.dumps(dump), encoding="utf-8")
