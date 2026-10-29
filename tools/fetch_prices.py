"""下載日線價格,寫成網站使用的 JSON(欄位式陣列、調整後價格),並做資料品質檢查。

    python tools/fetch_prices.py --out site/data

輸出:
    <out>/prices/<檔名>.json  每個標的一個檔案(檔名見 price_filename(): ^VIX → _5eVIX,和網站端 priceFileName() 一致)
    <out>/universe.json      網站的標的清單(只含通過品質檢查的標的),skipped 欄位記錄被排除的原因

調整後價格: 開高低依 adjclose / close 同比例換算(處理股利與分割),回測才不會被除息日的跳空騙到。

資料品質閘門(教訓來自 Yahoo 外匯日線: 約六成 K 棒的收盤價被填成開盤價):
  - 開收價「完全相同」但有振幅的 K 棒佔比 > 25%  → 排除(收盤價大致上是過期的)
  - 佔比 5%~25%                                     → 收錄,但在網站上標示警告
  - 有效 K 棒 < 250 根,或最新一根距今超過 10 天     → 排除 / 警告
  - 最新一根(今天尚未收盤的)K 棒一律丟掉,避免拿到殘缺的資料
只要通過的標的少於一半就以非 0 結束,讓 CI 變紅而不是默默發布空網站。
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

import requests

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
STALE_EXCLUDE = 0.25
STALE_WARN = 0.05
MIN_BARS = 250
MAX_AGE_DAYS = 10
MIN_OK_FRACTION = 0.5


class FetchError(RuntimeError):
    pass


def price_filename(symbol):
    """價格檔的檔名: 靜態網站伺服器會把網址裡的 %XX 先解碼再找檔案,所以檔名不能含需要編碼的字元(^VIX、CL=F)。
    其他字元換成 _ 加兩位十六進位(底線本身也是,所以不會撞名)。必須和 site/js/engine/data.js 的 priceFileName() 一致。"""
    return re.sub(r"[^A-Za-z0-9.\-]", lambda m: f"_{ord(m.group()):02x}", symbol)


def fetch_chart(session, symbol, years, now, retries=3, sleep=time.sleep):
    """呼叫 Yahoo chart API。429/5xx 會退避重試;其他錯誤直接丟出。"""
    params = {
        "period1": int((now - timedelta(days=int(years * 366) + 10)).timestamp()),
        "period2": int((now + timedelta(days=1)).timestamp()),
        "interval": "1d",
        "events": "div,splits",
        "includeAdjustedClose": "true",
    }
    last = None
    for attempt in range(retries):
        try:
            resp = session.get(CHART_URL.format(symbol=quote(symbol, safe="")), params=params, timeout=20,
                               headers={"User-Agent": "Mozilla/5.0 (strategy-lab data fetch)"})
        except requests.RequestException as e:
            last = e
        else:
            if resp.status_code in (429, 500, 502, 503, 504):
                last = FetchError(f"HTTP {resp.status_code}")
            elif resp.status_code != 200:
                raise FetchError(f"HTTP {resp.status_code}")
            else:
                return resp.json()
        if attempt < retries - 1:
            sleep(2 ** attempt)
    raise FetchError(f"重試 {retries} 次仍失敗: {last}")


def parse_chart(payload):
    """從 Yahoo 回應取出 (時間戳, 開高低收, 調整後收盤, 成交量, 時區位移秒數)。缺值是 None。"""
    chart = (payload or {}).get("chart") or {}
    if chart.get("error"):
        raise FetchError(f"Yahoo 錯誤: {chart['error']}")
    result = (chart.get("result") or [None])[0]
    if not result or not result.get("timestamp"):
        raise FetchError("Yahoo 沒有回傳任何 K 棒")
    q = result["indicators"]["quote"][0]
    adj = (result["indicators"].get("adjclose") or [{}])[0].get("adjclose")
    return {
        "ts": result["timestamp"],
        "o": q.get("open"), "h": q.get("high"), "l": q.get("low"), "c": q.get("close"), "v": q.get("volume"),
        "adj": adj or q.get("close"),
        "offset": (result.get("meta") or {}).get("gmtoffset", 0) or 0,
    }


def _sig(x):
    return float(f"{x:.6g}")


def build_series(parsed, today_local):
    """清理並換算成調整後價格。回傳 (series, stats)。today_local 是交易所當地「今天」的日期字串。"""
    d, o, h, l, c, v = [], [], [], [], [], []
    stats = {"raw": len(parsed["ts"]), "null": 0, "nonpositive": 0, "repaired": 0, "partial_dropped": 0}
    for i, ts in enumerate(parsed["ts"]):
        ro, rh, rl, rc, adj = (parsed[k][i] if parsed[k] is not None else None for k in ("o", "h", "l", "c", "adj"))
        if None in (ro, rh, rl, rc, adj):
            stats["null"] += 1
            continue
        if min(ro, rh, rl, rc, adj) <= 0:
            stats["nonpositive"] += 1
            continue
        date = datetime.fromtimestamp(ts + parsed["offset"], tz=timezone.utc).strftime("%Y-%m-%d")
        if date >= today_local:
            stats["partial_dropped"] += 1
            continue
        k = adj / rc
        ro, rh, rl, rc = ro * k, rh * k, rl * k, adj
        hi, lo = max(ro, rh, rl, rc), min(ro, rh, rl, rc)
        if hi != rh or lo != rl:
            stats["repaired"] += 1
            rh, rl = hi, lo
        vol = parsed["v"][i] if parsed["v"] is not None and parsed["v"][i] is not None else 0
        d.append(date)
        o.append(_sig(ro)); h.append(_sig(rh)); l.append(_sig(rl)); c.append(_sig(rc)); v.append(int(vol))
    # 同一天出現多筆(例如夏令時間切換)只留最後一筆
    seen = {}
    for i, date in enumerate(d):
        seen[date] = i
    keep = sorted(seen.values())
    series = {"d": [d[i] for i in keep], "o": [o[i] for i in keep], "h": [h[i] for i in keep],
              "l": [l[i] for i in keep], "c": [c[i] for i in keep], "v": [v[i] for i in keep]}
    n = len(series["d"])
    stale = sum(1 for i in range(n) if abs(series["o"][i] - series["c"][i]) < 1e-9 and series["h"][i] > series["l"][i])
    stats.update(n=n, duplicates=len(d) - n, stale_share=(stale / n if n else 0.0))
    return series, stats


def verdict(series, stats, today_local):
    """回傳 (是否收錄, 警告文字或空字串, 排除原因或空字串)。"""
    if stats["n"] < MIN_BARS:
        return False, "", f"有效 K 棒只有 {stats['n']} 根(至少需要 {MIN_BARS} 根)"
    share = stats["stale_share"]
    if share > STALE_EXCLUDE:
        return False, "", f"{share:.0%} 的 K 棒開盤價等於收盤價,收盤價疑似過期"
    warns = []
    if share > STALE_WARN:
        warns.append(f"{share:.0%} 的 K 棒開盤價等於收盤價,收盤價可能過期,績效可能失真")
    age = (datetime.strptime(today_local, "%Y-%m-%d") - datetime.strptime(series["d"][-1], "%Y-%m-%d")).days
    if age > MAX_AGE_DAYS:
        warns.append(f"最新資料是 {series['d'][-1]},距今 {age} 天")
    return True, ";".join(warns), ""


def main(argv=None, session=None, now=None, sleep=time.sleep):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--universe", default=str(Path(__file__).with_name("universe.json")))
    ap.add_argument("--years", type=float, default=12)
    ap.add_argument("--pause", type=float, default=0.6, help="每個標的之間的間隔秒數(降低被限流的機率)")
    args = ap.parse_args(argv)

    now = now or datetime.now(timezone.utc)
    session = session or requests.Session()
    universe = json.loads(Path(args.universe).read_text(encoding="utf-8"))
    out = Path(args.out)
    (out / "prices").mkdir(parents=True, exist_ok=True)

    assets, skipped = [], []
    for item in universe:
        sym = item["id"]
        try:
            parsed = parse_chart(fetch_chart(session, sym, args.years, now, sleep=sleep))
            today_local = datetime.fromtimestamp(now.timestamp() + parsed["offset"], tz=timezone.utc).strftime("%Y-%m-%d")
            series, stats = build_series(parsed, today_local)
            ok, warn, reason = verdict(series, stats, today_local)
        except (FetchError, KeyError, IndexError, TypeError, ValueError) as e:
            skipped.append({"id": sym, "reason": f"下載或解析失敗: {e}"})
            print(f"SKIP {sym}: {e}", file=sys.stderr)
            continue
        finally:
            sleep(args.pause)
        if not ok:
            skipped.append({"id": sym, "reason": reason})
            print(f"EXCLUDE {sym}: {reason}", file=sys.stderr)
            continue
        payload = {"symbol": sym, "name": item.get("name", sym), "source": "yahoo", "adjusted": True,
                   "updated": now.strftime("%Y-%m-%d"), **series}
        (out / "prices" / f"{price_filename(sym)}.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        assets.append({"id": sym, "name": item.get("name", sym), "category": item.get("category", "其他"),
                       "first": series["d"][0], "last": series["d"][-1], "n": stats["n"], "warn": warn})
        print(f"OK   {sym}: {stats['n']} 根 {series['d'][0]} ~ {series['d'][-1]}"
              f"{'  ⚠ ' + warn if warn else ''}  (修正 {stats['repaired']}、空值 {stats['null']})")

    (out / "universe.json").write_text(json.dumps(
        {"updated": now.strftime("%Y-%m-%d %H:%M UTC"), "assets": assets, "skipped": skipped}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"完成: 收錄 {len(assets)} / {len(universe)},排除 {len(skipped)}")
    if len(assets) < len(universe) * MIN_OK_FRACTION:
        print("通過品質檢查的標的不到一半,視為失敗(保留上一次發布的網站)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
