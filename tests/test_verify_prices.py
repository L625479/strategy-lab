import json
import random

import pytest

from tools import verify_prices as vp


def make_pair(n=400, seed=1, noise=0.0, adj=0.9, level=1.0):
    """我們的資料(調整後 = 原始 × adj)與「另一個來源」的原始資料。noise = 另一邊每天日內報酬的偏差。"""
    rng = random.Random(seed)
    dates = [f"2024-{1 + i // 28:02d}-{1 + i % 28:02d}" for i in range(n)]
    ours = {"d": dates, "o": [], "h": [], "l": [], "c": []}
    other = {}
    p = 100.0
    for i, d in enumerate(dates):
        k = adj if i < n - 10 else 1.0                 # 股利調整只影響「之前」的價格;最近幾天(還沒有後來的除息)等於原始價
        o = p * (1 + rng.gauss(0, 0.004))
        c = o * (1 + rng.gauss(0, 0.012))
        h, l = max(o, c) * (1 + abs(rng.gauss(0, 0.004))), min(o, c) * (1 - abs(rng.gauss(0, 0.004)))
        for name, v in zip("ohlc", (o, h, l, c)):
            ours[name].append(v * k)
        other[d] = (o, h, l, c * (1 + rng.gauss(0, noise)) * level)
        p = c
    return ours, other


def test_matching_sources_pass_even_though_ours_is_dividend_adjusted():
    ours, other = make_pair()
    r = vp.compare(ours, other)
    assert r["ok"] and r["corr"] > 0.9999 and r["median_diff"] < 1e-12 and r["overlap"] == 400


def test_small_vendor_noise_is_tolerated_but_wrong_data_is_not():
    assert vp.compare(*make_pair(noise=0.0004))["ok"]
    bad = vp.compare(*make_pair(noise=0.01))
    assert not bad["ok"] and "相關係數" in bad["reason"] or "中位數" in bad["reason"]


def test_stale_closes_are_detected():
    ours, other = make_pair()
    ours["c"] = list(ours["o"])                       # 收盤價被填成開盤價(過期的收盤價)
    r = vp.compare(ours, other)
    assert not r["ok"] and (r["corr"] != r["corr"] or r["corr"] < 0.5)     # 全部日內報酬都是 0 → 沒有變異,相關係數算不出來(NaN)也算不通過


def test_price_level_mismatch_on_recent_days_is_detected():
    r = vp.compare(*make_pair(level=1.05))            # 單位或分割沒調整: 水準差 5%
    assert not r["ok"] and "收盤價水準" in r["reason"]


def test_too_little_overlap_is_a_failure_not_a_pass():
    r = vp.compare(*make_pair(n=120))
    assert not r["ok"] and "至少需要" in r["reason"]


def test_symbol_mapping():
    assert vp.stooq_symbol("SPY") == "spy.us" and vp.stooq_symbol("^VIX") == "^vix"
    assert all(vp.stooq_symbol(s) is None for s in ("2330.TW", "BTC-USD", "CL=F"))


class Resp:
    def __init__(self, status, text):
        self.status_code, self.text = status, text


class FakeSession:
    def __init__(self, by_symbol):
        self.by_symbol = by_symbol

    def get(self, url, **kw):
        return self.by_symbol[url.split("s=")[1].split("&")[0]]


def csv_of(other):
    return "Date,Open,High,Low,Close\n" + "\n".join(f"{d},{o},{h},{l},{c}" for d, (o, h, l, c) in other.items())


def write_data(tmp_path, ours_by_sym):
    (tmp_path / "prices").mkdir()
    for sym, ours in ours_by_sym.items():
        (tmp_path / "prices" / f"{vp.price_filename(sym)}.json").write_text(json.dumps(ours), encoding="utf-8")
    (tmp_path / "universe.json").write_text(json.dumps({"assets": [{"id": s} for s in ours_by_sym]}), encoding="utf-8")


def test_main_exit_codes(tmp_path, capsys):
    good, good_other = make_pair(seed=1)
    bad, bad_other = make_pair(seed=2)
    bad["c"] = list(bad["o"])
    write_data(tmp_path, {"SPY": good, "QQQ": bad, "2330.TW": good})
    sess = FakeSession({"spy.us": Resp(200, csv_of(good_other)), "qqq.us": Resp(200, csv_of(bad_other))})
    assert vp.main(["--data", str(tmp_path)], session=sess) == 1
    out = capsys.readouterr().out
    assert "SPY" in out and "通過 1、對不上 1" in out and "2330.TW" in out
    assert vp.main(["--data", str(tmp_path), "--tickers", "SPY"], session=sess) == 0


def test_main_reports_unavailable_source_instead_of_claiming_success(tmp_path, capsys):
    good, _ = make_pair()
    write_data(tmp_path, {"SPY": good})
    sess = FakeSession({"spy.us": Resp(200, "Exceeded the daily hits limit")})
    assert vp.main(["--data", str(tmp_path)], session=sess) == 2
    assert "來源取不到資料" in capsys.readouterr().out
