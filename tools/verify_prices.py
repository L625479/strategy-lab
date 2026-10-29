"""用「另一個獨立的資料來源」交叉驗證 fetch_prices.py 抓下來的價格。

    python tools/fetch_prices.py --out /tmp/data
    python tools/verify_prices.py --data /tmp/data

獨立來源(都是不需要註冊的公開資料):
  - 美股與 ETF: Nasdaq 的歷史行情(未經股利調整的原始價格)
  - ^VIX:      CBOE 公布的 VIX 歷史資料
  - ^IRX:      美國財政部公布的 3 個月期殖利率

股票與 ETF 比較每天的「日內報酬」C/O-1 與「振幅」H/L-1。調整後價格是把開高低收乘上同一個係數,所以這兩個比值不受股利調整影響:
兩個來源的原始資料若一致,這兩個比值就會一致;資料被填成過期值、K 棒錯位、價格單位錯誤都會讓它們對不上。
另外比較最近 3 天的收盤價水準(最近幾天還沒有被後來的除息調整過,應該和原始收盤價一致)。
利率比較兩個序列的水準差與相關係數(IRX 是貼現率、財政部是債券等值殖利率,定義不同,所以允許小幅水準差)。

來源取不到資料時結束碼是 2(無法驗證,不代表資料有錯,也不能當作通過);對不上是 1;全部通過是 0。
"""

import argparse
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from tools.fetch_prices import price_filename  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept": "application/json, text/csv, */*"}
NASDAQ_URL = "https://api.nasdaq.com/api/quote/{symbol}/historical?assetclass={assetclass}&fromdate={start}&todate={end}&limit=9999"
CBOE_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"
TREASURY_URL = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all"
                "?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
MIN_OVERLAP = 200
MIN_CORR = 0.98
MAX_MEDIAN_DIFF = 0.0005          # 日內報酬差的中位數(0.05%)
MAX_BIG_SHARE = 0.02              # 日內報酬差超過 0.5% 的天數佔比上限
MAX_LEVEL_DIFF = 0.02             # 最近 3 天收盤價水準差(除息可能造成 < 2% 的差)
MAX_RATE_DIFF = 0.30              # 利率差的中位數上限(百分點)


class SourceUnavailable(RuntimeError):
    pass


def iso_date(text):
    return datetime.strptime(text.strip(), "%m/%d/%Y").strftime("%Y-%m-%d")


def num(text):
    return float(str(text).replace("$", "").replace(",", "").strip())


# --- 取得與解析各來源 ------------------------------------------------------------

def parse_nasdaq(payload):
    rows = ((payload or {}).get("data") or {}).get("tradesTable", {}).get("rows") or []
    if not rows:
        raise SourceUnavailable("Nasdaq 沒有回傳任何列")
    out = {}
    for r in rows:
        try:
            out[iso_date(r["date"])] = (num(r["open"]), num(r["high"]), num(r["low"]), num(r["close"]))
        except (KeyError, ValueError):
            continue
    return out


def parse_cboe(text):
    lines = text.strip().splitlines()
    if not lines or not lines[0].upper().startswith("DATE"):
        raise SourceUnavailable(f"CBOE 回應不是 CSV: {text[:80]!r}")
    out = {}
    for line in lines[1:]:
        p = line.split(",")
        try:
            out[iso_date(p[0])] = tuple(float(x) for x in p[1:5])
        except (ValueError, IndexError):
            continue
    return out


def parse_treasury(text, column="3 Mo"):
    lines = text.strip().splitlines()
    head = [h.strip().strip('"') for h in lines[0].split(",")] if lines else []
    if "Date" not in head or column not in head:
        raise SourceUnavailable(f"財政部回應不是預期的 CSV: {text[:80]!r}")
    i, j = head.index("Date"), head.index(column)
    out = {}
    for line in lines[1:]:
        p = [x.strip().strip('"') for x in line.split(",")]
        try:
            out[iso_date(p[i])] = float(p[j])
        except (ValueError, IndexError):
            continue
    return out


def _get(session, url, timeout=40):
    try:
        resp = session.get(url, timeout=timeout, headers=UA, allow_redirects=True)
    except requests.RequestException as e:
        raise SourceUnavailable(str(e)) from e
    if resp.status_code != 200:
        raise SourceUnavailable(f"HTTP {resp.status_code}: {resp.text[:80]!r}")
    return resp


def fetch_nasdaq(session, symbol, assetclass, days, today=None):
    today = today or datetime.now(timezone.utc).date()
    start = today - timedelta(days=int(days * 1.6) + 10)
    resp = _get(session, NASDAQ_URL.format(symbol=symbol, assetclass=assetclass, start=start.isoformat(), end=today.isoformat()))
    try:
        return parse_nasdaq(resp.json())
    except ValueError as e:
        raise SourceUnavailable(f"Nasdaq 回應不是 JSON: {resp.text[:80]!r}") from e


def fetch_cboe(session):
    return parse_cboe(_get(session, CBOE_URL).text)


def fetch_treasury(session, years):
    out = {}
    for y in years:
        out.update(parse_treasury(_get(session, TREASURY_URL.format(year=y)).text))
    return out


# --- 比較 ------------------------------------------------------------------------

def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx, syy = sum((x - mx) ** 2 for x in xs), sum((y - my) ** 2 for y in ys)
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
    stats = dict(overlap=n, corr=pearson(ret_a, ret_b), median_diff=diffs[n // 2], big_share=sum(1 for x in diffs if x > 0.005) / n,
                 range_corr=pearson(rng_a, rng_b))
    last = [d for d in ours["d"] if d in other][-3:]
    stats["level_diff"] = max((abs(ours["c"][idx[d]] / other[d][3] - 1) for d in last), default=0.0)
    problems = []
    if not stats["corr"] >= MIN_CORR:
        problems.append(f"日內報酬相關係數 {stats['corr']:.4f} < {MIN_CORR}")
    if stats["median_diff"] > MAX_MEDIAN_DIFF:
        problems.append(f"日內報酬差的中位數 {stats['median_diff']:.4%} > {MAX_MEDIAN_DIFF:.2%}")
    if stats["big_share"] > MAX_BIG_SHARE:
        problems.append(f"{stats['big_share']:.1%} 的天數日內報酬差超過 0.5%")
    if stats["level_diff"] > MAX_LEVEL_DIFF:
        problems.append(f"最近收盤價水準相差 {stats['level_diff']:.2%}")
    stats.update(ok=not problems, reason=";".join(problems))
    return stats


def compare_rate(ours, other, days=500):
    """利率(百分比)的收盤水準: 兩個來源每天的差與相關係數。"""
    dates = [d for d in ours["d"] if d in other][-days:]
    idx = {d: i for i, d in enumerate(ours["d"])}
    a = [ours["c"][idx[d]] for d in dates]
    b = [other[d] for d in dates]
    n = len(a)
    if n < MIN_OVERLAP:
        return dict(ok=False, overlap=n, reason=f"重疊的交易日只有 {n} 天(至少需要 {MIN_OVERLAP})")
    diffs = sorted(abs(x - y) for x, y in zip(a, b))
    stats = dict(overlap=n, corr=pearson(a, b), median_diff=diffs[n // 2])
    problems = []
    if not stats["corr"] >= MIN_CORR:
        problems.append(f"水準相關係數 {stats['corr']:.4f} < {MIN_CORR}")
    if stats["median_diff"] > MAX_RATE_DIFF:
        problems.append(f"利率差的中位數 {stats['median_diff']:.2f} 個百分點 > {MAX_RATE_DIFF}")
    stats.update(ok=not problems, reason=";".join(problems))
    return stats


def kind_of(asset):
    """這個標的用哪個獨立來源驗證: ('nasdaq', 'etf'|'stocks') / ('cboe',) / ('treasury',) / None"""
    sym, cat = asset["id"], asset.get("category", "")
    if sym == "^VIX":
        return ("cboe",)
    if sym == "^IRX":
        return ("treasury",)
    if sym.startswith("^") or "." in sym or "-" in sym or "=" in sym:
        return None
    if "ETF" in cat or "債券" in cat or "商品" in cat:
        return ("nasdaq", "etf")
    if cat == "美股":
        return ("nasdaq", "stocks")
    return None


def main(argv=None, session=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default="site/data")
    ap.add_argument("--days", type=int, default=500)
    ap.add_argument("--tickers", default="", help="逗號分隔;預設是資料夾裡有獨立來源可比對的全部標的")
    ap.add_argument("--pause", type=float, default=0.5)
    args = ap.parse_args(argv)
    session = session or requests.Session()
    data = Path(args.data)
    assets = json.loads((data / "universe.json").read_text(encoding="utf-8"))["assets"]
    want = {t for t in args.tickers.split(",") if t}
    checked, skipped, failed, unavailable = [], [], [], []
    cache = {}
    print(f"{'標的':<8}{'來源':<9}{'重疊天數':>8}{'日內報酬相關':>12}{'差的中位數':>12}{'差>0.5%':>9}{'振幅相關':>9}{'收盤水準差':>11}  結果")
    import time
    for a in assets:
        sym = a["id"]
        if want and sym not in want:
            continue
        kind = kind_of(a)
        if kind is None:
            skipped.append(sym)
            continue
        ours = json.loads((data / "prices" / f"{price_filename(sym)}.json").read_text(encoding="utf-8"))
        try:
            if kind[0] == "nasdaq":
                other = fetch_nasdaq(session, sym, kind[1], args.days)
                time.sleep(args.pause)
            elif kind[0] == "cboe":
                other = cache.get("cboe") or cache.setdefault("cboe", fetch_cboe(session))
            else:
                years = sorted({int(d[:4]) for d in ours["d"][-args.days:]})
                other = cache.get("treasury") or cache.setdefault("treasury", fetch_treasury(session, years))
        except SourceUnavailable as e:
            unavailable.append(sym)
            print(f"{sym:<8}{kind[0]:<9} 來源取不到資料: {e}")
            continue
        r = compare_rate(ours, other, args.days) if kind[0] == "treasury" else compare(ours, other, args.days)
        if "corr" not in r:
            failed.append(sym)
            print(f"{sym:<8}{kind[0]:<9}{r['overlap']:>8}  {r['reason']}")
            continue
        (checked if r["ok"] else failed).append(sym)
        if kind[0] == "treasury":
            print(f"{sym:<8}{kind[0]:<9}{r['overlap']:>8}{'(水準) ' + format(r['corr'], '.4f'):>12}{r['median_diff']:>9.2f} pp{'':>9}{'':>9}{'':>11}  {'通過' if r['ok'] else '對不上: ' + r['reason']}")
        else:
            print(f"{sym:<8}{kind[0]:<9}{r['overlap']:>8}{r['corr']:>12.4f}{r['median_diff']:>12.4%}{r['big_share']:>9.1%}{r['range_corr']:>9.4f}{r['level_diff']:>11.2%}  {'通過' if r['ok'] else '對不上: ' + r['reason']}")
    print(f"\n通過 {len(checked)}、對不上 {len(failed)}、來源取不到 {len(unavailable)}、沒有獨立來源可比對而略過 {len(skipped)}: {', '.join(skipped)}")
    if failed:
        return 1
    if unavailable:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
