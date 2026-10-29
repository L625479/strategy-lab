"""Yahoo chart 回應的標準測試案例,以及 tools/fetch_prices.py 對它們算出的標準答案。

JS 版(tools/yahoo.mjs)用同一批案例與同一份標準答案測試(tests-js/yahoo.test.js),所以「Python 版 = 標準答案 = JS 版」。
tests/test_yahoo_golden.py 確認 tests-js/fixtures/ 裡的檔案沒有過期;改了案例或 Python 的清理邏輯之後重新產生:

    python tests/yahoo_cases.py --write
"""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools import fetch_prices as fp  # noqa: E402

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)
FIXTURES = Path(__file__).resolve().parent.parent / "tests-js" / "fixtures"


def payload(n=300, start="2026-01-02", offset=-18000, hour_utc=14, price0=100.0, amp=0.01, step=1, adj_factor=1.0,
            stale_every=0, flat_every=0, nulls=(), nonpos=(), high_low_bad=(), no_adj=False, volume_none=(), extra_ts=(), drop_volume=False):
    """合成的 Yahoo chart 回應。每根 K 棒都用 start 起算的整天數(step)排。"""
    t0 = datetime.strptime(start, "%Y-%m-%d").replace(hour=hour_utc, tzinfo=timezone.utc)
    ts, o, h, l, c, adj, v = [], [], [], [], [], [], []
    price = price0
    for i in range(n):
        ts.append(int((t0 + timedelta(days=i * step)).timestamp()))
        op = price
        cl = op * (1 + amp * (1 if i % 3 else -1.2))
        if stale_every and i % stale_every == 0:
            cl = op
        o.append(round(op, 4)); c.append(round(cl, 4)); h.append(round(max(op, cl) * 1.004, 4)); l.append(round(min(op, cl) * 0.996, 4))
        if flat_every and i % flat_every == 0:       # 一字線: 開高低收完全相同(不算「收盤價過期」,因為沒有振幅)
            cl = op
            c[-1] = h[-1] = l[-1] = o[-1]
        adj.append(round(cl * adj_factor, 4) if adj_factor != 1.0 else round(cl, 4)); v.append(1000 + 7 * i)
        price = cl
    for i in nulls:
        o[i] = h[i] = l[i] = c[i] = adj[i] = None
    for i in nonpos:
        l[i] = 0.0
    for i in high_low_bad:
        h[i] = round(min(o[i], c[i]) * 0.99, 4)      # 最高價比開收價都低: 要被修正
    for i in volume_none:
        v[i] = None
    ts = list(ts) + list(extra_ts)
    for arr in (o, h, l, c, adj, v):
        arr.extend([o[-1]] * len(extra_ts) if arr is not v else [1] * len(extra_ts))
    quote = {"open": o, "high": h, "low": l, "close": c}
    if not drop_volume:
        quote["volume"] = v
    indicators = {"quote": [quote]}
    if not no_adj:
        indicators["adjclose"] = [{"adjclose": adj}]
    return {"chart": {"error": None, "result": [{"meta": {"gmtoffset": offset, "symbol": "TEST", "shortName": "Test Co"}, "timestamp": ts, "indicators": indicators}]}}


def cases():
    out = {}
    out["plain"] = payload()
    out["dividend_adjusted"] = payload(adj_factor=0.9731)
    out["nulls_nonpositive_repairs"] = payload(nulls=(3, 4, 120), nonpos=(10, 11), high_low_bad=(20, 21, 22), volume_none=(5, 6))
    out["no_adjclose_no_volume"] = payload(no_adj=True, drop_volume=True)
    # 最後一根是交易所當地「今天」(2026-10-29) 的 K 棒: 要丟掉;再多一根「昨天」的夏令時間重複
    out["partial_today_and_duplicate_day"] = payload(n=300, start="2025-01-02", extra_ts=(int(datetime(2026, 10, 29, 14, 30, tzinfo=timezone.utc).timestamp()),))
    dup = payload(n=300, start="2025-01-02")
    dup["chart"]["result"][0]["timestamp"][100] = dup["chart"]["result"][0]["timestamp"][99] + 3600   # 同一天兩筆: 留最後一筆
    out["duplicate_local_day"] = dup
    # 比特幣: 7 天交易、時區 0、價格剛好落在「6 位有效數字」的正中間(Python 進位到偶數、JS 的 toPrecision 進位到較大的數)
    btc = payload(n=300, start="2025-12-01", offset=0, hour_utc=0, price0=100000.5, amp=0.002)
    q = btc["chart"]["result"][0]["indicators"]
    for i, base in enumerate([100000.5, 100001.5, 100002.5, 100003.5, 123456.5, 99999.95]):
        for arr in (q["quote"][0]["open"], q["quote"][0]["close"], q["adjclose"][0]["adjclose"]):
            arr[i] = base
        q["quote"][0]["high"][i] = base + 3; q["quote"][0]["low"][i] = base - 3
    out["btc_ties"] = btc
    out["asia_offset"] = payload(n=300, start="2026-01-02", offset=28800, hour_utc=20)           # UTC 20:00 = 當地隔天 04:00: 日期要用當地的
    out["west_offset_previous_day"] = payload(n=300, start="2026-01-02", offset=-18000, hour_utc=2)   # UTC 02:00 = 當地前一天 21:00
    out["flat_bars"] = payload(n=300, flat_every=3)                                       # 三分之一是一字線: 沒有振幅,不算收盤價過期
    out["stale_one_eighth"] = payload(n=256, start="2026-02-02", stale_every=8)         # 32 / 256 = 12.5%: 警告文字裡的百分比要進位到偶數(12%)
    out["stale_excluded"] = payload(n=300, stale_every=3)
    out["stale_exactly_quarter"] = payload(n=256, start="2026-02-02", stale_every=4)         # 64 / 256 = 25%: 「大於」才排除,剛好 25% 收錄(警告)
    out["stale_exactly_five_percent"] = payload(n=300, stale_every=20)                       # 15 / 300 = 5%: 「大於」才警告,剛好 5% 不警告
    out["stale_warn_only"] = payload(n=300, stale_every=12)
    out["too_few_bars"] = payload(n=120)
    out["bars_250"] = payload(n=250, start="2026-01-02", step=1)                              # 剛好 250 根: 收錄
    out["bars_249"] = payload(n=249, start="2026-01-02", step=1)                              # 249 根: 排除
    out["bars_30"] = payload(n=30, start="2026-09-01", step=1)                                # 使用者輸入的標的下限(JS 版 minBars=30)
    out["bars_29"] = payload(n=29, start="2026-09-01", step=1)
    out["old_last_bar"] = payload(n=300, start="2025-01-02", step=1)                    # 最後一根 2025-10-28 之前: 距今很久
    # 最後一根剛好距「今天」10 天(2026-10-19)不警告,11 天(2026-10-18)警告
    out["age_exactly_10_days"] = payload(n=300, start=(datetime(2026, 10, 19) - timedelta(days=299)).strftime("%Y-%m-%d"), hour_utc=14)
    out["age_11_days"] = payload(n=300, start=(datetime(2026, 10, 18) - timedelta(days=299)).strftime("%Y-%m-%d"), hour_utc=14)
    out["empty"] = {"chart": {"error": None, "result": [{"meta": {"gmtoffset": 0}, "timestamp": [], "indicators": {"quote": [{}]}}]}}
    out["yahoo_error"] = {"chart": {"error": {"code": "Not Found", "description": "No data found, symbol may be delisted"}, "result": None}}
    return out


def run_python(p):
    """tools/fetch_prices.py 對一份回應的處理結果(和 main() 裡的流程相同)。"""
    try:
        parsed = fp.parse_chart(p)
    except fp.FetchError as e:
        return {"error": str(e)}
    today_local = datetime.fromtimestamp(NOW.timestamp() + parsed["offset"], tz=timezone.utc).strftime("%Y-%m-%d")
    series, stats = fp.build_series(parsed, today_local)
    ok, warn, reason = fp.verdict(series, stats, today_local)
    return {"today_local": today_local, "series": series, "stats": stats, "ok": ok, "warn": warn, "reason": reason}


def build():
    payloads = cases()
    return payloads, {name: run_python(p) for name, p in payloads.items()}


if __name__ == "__main__":
    if "--write" in sys.argv:
        payloads, golden = build()
        FIXTURES.mkdir(exist_ok=True)
        (FIXTURES / "yahoo_payloads.json").write_text(json.dumps(payloads, separators=(",", ":")), encoding="utf-8")
        (FIXTURES / "yahoo_golden.json").write_text(json.dumps(golden, separators=(",", ":")), encoding="utf-8")
        print({k: (v.get("ok"), v.get("stats", {}).get("n"), v.get("error")) for k, v in golden.items()})
    else:
        print(__doc__)
