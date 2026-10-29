import json
import random
from datetime import date, timedelta

import pytest

from tools import verify_prices as vp


def dates_of(n):
    d0, out = date(2023, 1, 2), []
    while len(out) < n:
        if d0.weekday() < 5:
            out.append(d0.isoformat())
        d0 += timedelta(days=1)
    return out


def make_pair(n=400, seed=1, noise=0.0, adj=0.9, level=1.0):
    """我們的資料(調整後;只有「之前」的價格被股利調整)與「另一個來源」的原始資料。noise = 另一邊收盤價的隨機偏差。"""
    rng = random.Random(seed)
    dates = dates_of(n)
    ours = {"d": dates, "o": [], "h": [], "l": [], "c": []}
    other = {}
    p = 100.0
    for i, d in enumerate(dates):
        k = adj if i < n - 10 else 1.0
        o = p * (1 + rng.gauss(0, 0.004))
        c = o * (1 + rng.gauss(0, 0.012))
        h, l = max(o, c) * (1 + abs(rng.gauss(0, 0.004))), min(o, c) * (1 - abs(rng.gauss(0, 0.004)))
        for name, v in zip("ohlc", (o, h, l, c)):
            ours[name].append(v * k)
        other[d] = (o, h, l, c * (1 + rng.gauss(0, noise)) * level)
        p = c
    return ours, other


def test_matching_sources_pass_even_though_ours_is_dividend_adjusted():
    r = vp.compare(*make_pair())
    assert r["ok"] and r["corr"] > 0.9999 and r["median_diff"] < 1e-12 and r["overlap"] == 400


def test_small_vendor_noise_is_tolerated_but_wrong_data_is_not():
    assert vp.compare(*make_pair(noise=0.0004))["ok"]
    bad = vp.compare(*make_pair(noise=0.01))
    assert not bad["ok"]


def test_stale_closes_are_detected():
    ours, other = make_pair()
    ours["c"] = list(ours["o"])                       # 收盤價被填成開盤價(過期的收盤價)
    r = vp.compare(ours, other)
    assert not r["ok"] and (r["corr"] != r["corr"] or r["corr"] < 0.5)     # 全部日內報酬都是 0 → 相關係數算不出來(NaN)也算不通過


def test_price_level_mismatch_on_recent_days_is_detected():
    r = vp.compare(*make_pair(level=1.05))
    assert not r["ok"] and "收盤價水準" in r["reason"]


def test_too_little_overlap_is_a_failure_not_a_pass():
    r = vp.compare(*make_pair(n=120))
    assert not r["ok"] and "至少需要" in r["reason"]


def test_rate_comparison_allows_a_definition_gap_but_not_a_wrong_series():
    dates = dates_of(300)
    rng = random.Random(3)
    base = [4 + 0.5 * __import__("math").sin(i / 30) + rng.gauss(0, 0.02) for i in range(300)]
    ours = {"d": dates, "c": [x - 0.10 for x in base]}                      # IRX 是貼現率,比財政部的債券等值殖利率低一點
    assert vp.compare_rate(ours, dict(zip(dates, base)))["ok"]
    shuffled = dict(zip(dates, reversed(base)))
    assert not vp.compare_rate(ours, shuffled)["ok"]
    assert not vp.compare_rate({"d": dates, "c": [x + 1.0 for x in base]}, dict(zip(dates, base)))["ok"]


def test_parsers_for_each_source():
    nasdaq = {"data": {"tradesTable": {"rows": [{"date": "10/28/2026", "close": "$343.83", "volume": "1", "open": "$346.92", "high": "$347.18", "low": "$343.52"},
                                                {"date": "10/27/2026", "close": "1,772.31", "volume": "1", "open": "1,771.43", "high": "1,773.36", "low": "1,769.24"}]}}}
    assert vp.parse_nasdaq(nasdaq) == {"2026-10-28": (346.92, 347.18, 343.52, 343.83), "2026-10-27": (1771.43, 1773.36, 1769.24, 1772.31)}
    with pytest.raises(vp.SourceUnavailable):
        vp.parse_nasdaq({"data": None})
    assert vp.parse_cboe("DATE,OPEN,HIGH,LOW,CLOSE\n10/28/2026,17.1,17.9,16.5,17.2\n") == {"2026-10-28": (17.1, 17.9, 16.5, 17.2)}
    with pytest.raises(vp.SourceUnavailable):
        vp.parse_cboe("<html>307</html>")
    assert vp.parse_treasury('Date,"1 Mo","3 Mo"\n10/28/2026,4.07,4.18\n') == {"2026-10-28": 4.18}
    with pytest.raises(vp.SourceUnavailable):
        vp.parse_treasury("nope")


def test_which_independent_source_applies():
    k = vp.kind_of
    assert k({"id": "SPY", "category": "美股 ETF"}) == ("nasdaq", "etf")
    assert k({"id": "GLD", "category": "債券 / 商品"}) == ("nasdaq", "etf")
    assert k({"id": "AAPL", "category": "美股"}) == ("nasdaq", "stocks")
    assert k({"id": "^VIX", "category": "指數"}) == ("cboe",) and k({"id": "^IRX", "category": "指數"}) == ("treasury",)
    assert all(k({"id": s, "category": c}) is None for s, c in (("2330.TW", "台股"), ("BTC-USD", "加密貨幣"), ("CL=F", "商品"), ("^SOX", "指數")))


class Resp:
    def __init__(self, status, text="", body=None):
        self.status_code, self.text, self._body = status, text, body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class FakeSession:
    def __init__(self, routes):
        self.routes, self.urls = routes, []

    def get(self, url, **kw):
        self.urls.append(url)
        for key, resp in self.routes.items():
            if key in url:
                return resp
        raise AssertionError(f"unexpected url {url}")


def nasdaq_body(other):
    rows = [{"date": datetime_us(d), "open": f"${o}", "high": f"${h}", "low": f"${l}", "close": f"${c}", "volume": "1"} for d, (o, h, l, c) in other.items()]
    return {"data": {"tradesTable": {"rows": rows}}}


def datetime_us(iso):
    y, m, d = iso.split("-")
    return f"{m}/{d}/{y}"


def write_data(tmp_path, assets):
    (tmp_path / "prices").mkdir()
    for a, ours in assets:
        (tmp_path / "prices" / f"{vp.price_filename(a['id'])}.json").write_text(json.dumps(ours), encoding="utf-8")
    (tmp_path / "universe.json").write_text(json.dumps({"assets": [a for a, _ in assets]}), encoding="utf-8")


def test_main_exit_codes_and_report(tmp_path, capsys):
    good, good_other = make_pair(seed=1)
    bad, bad_other = make_pair(seed=2)
    bad["c"] = list(bad["o"])
    write_data(tmp_path, [({"id": "SPY", "category": "美股 ETF"}, good), ({"id": "AAPL", "category": "美股"}, bad), ({"id": "2330.TW", "category": "台股"}, good)])
    sess = FakeSession({"/SPY/": Resp(200, body=nasdaq_body(good_other)), "/AAPL/": Resp(200, body=nasdaq_body(bad_other))})
    assert vp.main(["--data", str(tmp_path), "--pause", "0"], session=sess) == 1
    out = capsys.readouterr().out
    assert "通過 1、對不上 1" in out and "略過 1: 2330.TW" in out
    assert any("assetclass=etf" in u for u in sess.urls) and any("assetclass=stocks" in u for u in sess.urls)
    assert vp.main(["--data", str(tmp_path), "--tickers", "SPY", "--pause", "0"], session=sess) == 0


def test_unreachable_source_is_exit_2_never_a_silent_pass(tmp_path, capsys):
    good, _ = make_pair()
    write_data(tmp_path, [({"id": "SPY", "category": "美股 ETF"}, good)])
    for resp in (Resp(200, "<!DOCTYPE html>blocked"), Resp(403, "Forbidden")):
        assert vp.main(["--data", str(tmp_path), "--pause", "0"], session=FakeSession({"/SPY/": resp})) == 2
    assert "來源取不到資料" in capsys.readouterr().out
