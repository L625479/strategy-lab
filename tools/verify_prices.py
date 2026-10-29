"""用「另一個獨立的資料來源」交叉驗證 fetch_prices.py 抓下來的價格。

    python tools/fetch_prices.py --out /tmp/data
    python tools/verify_prices.py --data /tmp/data

比較每天的「日內報酬」C/O-1 與「振幅」H/L-1。調整後價格是把開高低收乘上同一個係數,所以這兩個比值不受股利調整影響:
兩個來源的原始資料若一致,這兩個比值就會一致;資料被填成過期值、K 棒錯位、價格單位錯誤都會讓它們對不上。
另外比較最近幾天的收盤價水準(最近幾天還沒有被後來的除息調整過,應該和原始收盤價一致)。

來源是 Stooq(免註冊的日線 CSV)。只驗證 Stooq 有的標的(美股與 VIX);沒有的略過並列出。
結束碼: 0 全部通過;1 有標的對不上;2 來源取不到資料(無法驗證,不代表資料有錯)。
"""

import argparse
import json
import math
import sys
from datetime import datetime
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.fetch_prices import price_filename  # noqa: E402

STOOQ_URL = "https://stooq.com/q/d/l/?s={symbol}&i=d"
MIN_OVERLAP = 200
MIN_CORR = 0.98
MAX_MEDIAN_DIFF = 0.0005          # 日內報酬差的中位數(0.05%)
MAX_BIG_SHARE = 0.02              # 差超過 0.5% 的天數佔比上限
MAX_LEVEL_DIFF = 0.02             # 最近幾天收盤價水準差(除息可能造成 < 2% 的差)
HEADER = "Date,Open,High,Low,Close"


def stooq_symbol(sym):
    """Stooq 的代號: 美股 SPY → spy.us;指數 ^VIX → ^vix。沒有對應的回傳 None。"""
    if sym.startswith("^"):
        return sym.lower()
    if "." in sym or "-" in sym or "=" in sym:        # 台股、加密貨幣、期貨: Stooq 沒有可比較的版本
        return None
    return f"{sym.lower()}.us"


class SourceUnavailable(RuntimeError):
    pass


def fetch_stooq(session, symbol, timeout=30):
    resp = session.get(STOOQ_URL.format(symbol=symbol), timeout=timeout, headers={"User-Agent": "Mozilla/5.0 (strategy-lab data verification)"})
    text = resp.text.strip()
    if resp.status_code != 200 or not text.startswith(HEADER):
        raise SourceUnavailable(f"HTTP {resp.status_code}: {text[:80]!r}")
    rows = {}
    for line in text.splitlines()[1:]:
        p = line.split(",")
        try:
            rows[p[0]] = tuple(float(x) for x in p[1:5])
        except (ValueError, IndexError):
            continue
    return rows


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return float("nan")
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(sxx * syy)


def compare(ours, other, days=500):
    """ours: fetch_prices 寫出的 JSON(d,o,h,l,c);other: {日期: (o,h,l,c)}。回傳統計與是否通過。"""
    dates = [d for d in ours["d"] if d in other][-days:]
    idx = {d: i for i, d in enumerate(ours["d"])}
    ret_a, ret_b, rng_a, rng_b = [], [], [], []
    for d in dates:
        i = idx[d]
        o, h, l, c = ours["o"][i], ours["h"][i], ours["l"][i], ours["c"][i]
        so, sh, sl, sc = other[d]
        if min(o, l, so, sl) <= 0:
            continue
        ret_a.append(c / o - 1); ret_b.append(sc / so - 1)
        rng_a.append(h / l - 1); rng_b.append(sh / sl - 1)
    n = len(ret_a)
    if n < MIN_OVERLAP:
        return dict(ok=False, overlap=n, reason=f"重疊的交易日只有 {n} 天(至少需要 {MIN_OVERLAP})")
    diffs = sorted(abs(a - b) for a, b in zip(ret_a, ret_b))
    stats = dict(overlap=n, corr=pearson(ret_a, ret_b), median_diff=diffs[n // 2], p99_diff=diffs[int(n * 0.99)],
                 big_share=sum(1 for x in diffs if x > 0.005) / n, range_corr=pearson(rng_a, rng_b))
    # 最近 3 天的收盤價水準
    last = [d for d in ours["d"] if d in other][-3:]
    level = max((abs(ours["c"][idx[d]] / other[d][3] - 1) for d in last), default=0.0)
    stats["level_diff"] = level
    problems = []
    if not stats["corr"] >= MIN_CORR:
        problems.append(f"日內報酬相關係數 {stats['corr']:.4f} < {MIN_CORR}")
    if stats["median_diff"] > MAX_MEDIAN_DIFF:
        problems.append(f"日內報酬差的中位數 {stats['median_diff']:.4%} > {MAX_MEDIAN_DIFF:.2%}")
    if stats["big_share"] > MAX_BIG_SHARE:
        problems.append(f"{stats['big_share']:.1%} 的天數日內報酬差超過 0.5%")
    if level > MAX_LEVEL_DIFF:
        problems.append(f"最近收盤價水準相差 {level:.2%}")
    stats.update(ok=not problems, reason=";".join(problems))
    return stats


def main(argv=None, session=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default="site/data")
    ap.add_argument("--days", type=int, default=500)
    ap.add_argument("--tickers", default="", help="逗號分隔;預設是資料夾裡 Stooq 有的全部標的")
    args = ap.parse_args(argv)
    session = session or requests.Session()
    data = Path(args.data)
    universe = json.loads((data / "universe.json").read_text(encoding="utf-8"))["assets"]
    ids = [a["id"] for a in universe]
    want = [t for t in args.tickers.split(",") if t] or ids
    checked, skipped, failed, unavailable = [], [], [], []
    print(f"{'標的':<8}{'重疊天數':>8}{'日內報酬相關':>12}{'差的中位數':>12}{'差>0.5%':>9}{'振幅相關':>9}{'收盤水準差':>11}  結果")
    for sym in want:
        s = stooq_symbol(sym)
        if sym not in ids or s is None:
            skipped.append(sym)
            continue
        ours = json.loads((data / "prices" / f"{price_filename(sym)}.json").read_text(encoding="utf-8"))
        try:
            other = fetch_stooq(session, s)
        except (SourceUnavailable, requests.RequestException) as e:
            unavailable.append(sym)
            print(f"{sym:<8} 來源取不到資料: {e}")
            continue
        r = compare(ours, other, args.days)
        if "corr" not in r:
            failed.append(sym)
            print(f"{sym:<8}{r['overlap']:>8}  {r['reason']}")
            continue
        (checked if r["ok"] else failed).append(sym)
        print(f"{sym:<8}{r['overlap']:>8}{r['corr']:>12.4f}{r['median_diff']:>12.4%}{r['big_share']:>9.1%}{r['range_corr']:>9.4f}{r['level_diff']:>11.2%}  {'通過' if r['ok'] else '對不上: ' + r['reason']}")
    print(f"\n通過 {len(checked)}、對不上 {len(failed)}、來源取不到 {len(unavailable)}、略過(Stooq 沒有可比較的版本){len(skipped)}: {', '.join(skipped)}")
    if failed:
        return 1
    if unavailable and not checked:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
