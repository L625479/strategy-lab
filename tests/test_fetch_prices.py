import json
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote

import pytest
import requests

from tools import fetch_prices as fp

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)


def payload(n=300, start="2024-01-02", offset=-18000, hour_utc=14, stale_every=0, adj_factor=1.0,
            null_at=(), step_days=1):
    """合成的 Yahoo chart 回應。stale_every=k: 每 k 根有一根「開盤價 = 收盤價」(過期收盤價)。"""
    t0 = datetime.strptime(start, "%Y-%m-%d").replace(hour=hour_utc, tzinfo=timezone.utc)
    ts, o, h, l, c, adj, v = [], [], [], [], [], [], []
    price = 100.0
    for i in range(n):
        ts.append(int((t0 + timedelta(days=i * step_days)).timestamp()))
        op = price
        cl = op * (1 + 0.01 * (1 if i % 2 else -1))
        if stale_every and i % stale_every == 0:
            cl = op
        o.append(op); c.append(cl); h.append(max(op, cl) + 0.5); l.append(min(op, cl) - 0.5)
        adj.append(cl * adj_factor); v.append(1000 + i)
        price = cl
    for i in null_at:
        o[i] = h[i] = l[i] = c[i] = adj[i] = None
    return {"chart": {"error": None, "result": [{
        "meta": {"gmtoffset": offset}, "timestamp": ts,
        "indicators": {"quote": [{"open": o, "high": h, "low": l, "close": c, "volume": v}], "adjclose": [{"adjclose": adj}]},
    }]}}


class Resp:
    def __init__(self, status, body=None):
        self.status_code, self._body = status, body

    def json(self):
        return self._body


class FakeSession:
    """依網址裡的代號回傳預先準備好的回應;也記錄呼叫"""

    def __init__(self, by_symbol=None, default=None):
        self.by_symbol, self.default, self.calls = by_symbol or {}, default, []

    def get(self, url, params=None, timeout=None, headers=None):
        symbol = unquote(url.rsplit("/", 1)[-1])
        self.calls.append((symbol, params))
        r = self.by_symbol.get(symbol, self.default)
        if isinstance(r, Exception):
            raise r
        return r if isinstance(r, Resp) else Resp(200, r)


# --- 解析 ----------------------------------------------------------------------

def test_parse_keeps_nulls_and_falls_back_when_no_adjclose():
    p = payload(5, null_at=(2,))
    parsed = fp.parse_chart(p)
    assert parsed["c"][2] is None and parsed["offset"] == -18000
    del p["chart"]["result"][0]["indicators"]["adjclose"]
    assert fp.parse_chart(p)["adj"] == fp.parse_chart(p)["c"]


@pytest.mark.parametrize("bad", [None, {}, {"chart": {"error": {"code": "Not Found"}, "result": None}},
                                 {"chart": {"result": [{"timestamp": []}]}}])
def test_parse_rejects_error_and_empty_responses(bad):
    with pytest.raises(fp.FetchError):
        fp.parse_chart(bad)


# --- 清理與調整 -----------------------------------------------------------------

def test_adjusted_prices_scale_open_high_low_by_adjclose_over_close():
    parsed = fp.parse_chart(payload(40, adj_factor=0.5))
    series, stats = fp.build_series(parsed, "2030-01-01")
    raw_c = parsed["c"][3]
    assert series["c"][3] == pytest.approx(raw_c * 0.5, rel=1e-5)
    assert series["o"][3] == pytest.approx(parsed["o"][3] * 0.5, rel=1e-5)         # 開高低同比例換算
    assert series["h"][3] == pytest.approx(parsed["h"][3] * 0.5, rel=1e-5)
    assert stats["n"] == 40 and stats["repaired"] == 0


def test_null_rows_dropped_and_envelope_repaired():
    p = payload(40, null_at=(5,))
    p["chart"]["result"][0]["indicators"]["quote"][0]["high"][10] = 1.0           # high 低於 open/close
    series, stats = fp.build_series(fp.parse_chart(p), "2030-01-01")
    assert stats["null"] == 1 and stats["repaired"] == 1 and stats["n"] == 39
    assert all(series["h"][i] >= max(series["o"][i], series["c"][i], series["l"][i]) for i in range(39))
    assert all(series["l"][i] <= min(series["o"][i], series["c"][i], series["h"][i]) for i in range(39))


def test_todays_partial_bar_is_dropped():
    parsed = fp.parse_chart(payload(40, start="2026-09-20"))                      # 最後一根落在 2026-10-29
    series, stats = fp.build_series(parsed, "2026-10-29")
    assert series["d"][-1] == "2026-10-28" and stats["partial_dropped"] == 1


def test_local_date_uses_exchange_offset():
    # 台股 01:00 UTC 開盤(+8h)→ 同一天;晚上 20:00 UTC(+8h)已經是隔天
    taipei = fp.parse_chart(payload(3, start="2024-03-05", hour_utc=1, offset=28800))
    assert fp.build_series(taipei, "2030-01-01")[0]["d"][0] == "2024-03-05"
    late = fp.parse_chart(payload(3, start="2024-03-05", hour_utc=20, offset=28800))
    assert fp.build_series(late, "2030-01-01")[0]["d"][0] == "2024-03-06"


def test_duplicate_dates_keep_the_last():
    p = payload(40)
    ts = p["chart"]["result"][0]["timestamp"]
    ts[20] = ts[19]                                                                # 兩根同一天
    q = p["chart"]["result"][0]["indicators"]["quote"][0]
    q["close"][20] = p["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"][20] = 123.0   # 後面那一筆的收盤價
    series, stats = fp.build_series(fp.parse_chart(p), "2030-01-01")
    assert stats["duplicates"] == 1 and len(series["d"]) == len(set(series["d"])) == 39
    day = datetime.fromtimestamp(ts[19] - 18000, tz=timezone.utc).strftime("%Y-%m-%d")
    assert series["c"][series["d"].index(day)] == pytest.approx(123.0, rel=1e-4)          # 留下的是最後一筆


# --- 品質閘門 -------------------------------------------------------------------

def check(n=300, **kw):
    # 預設讓最新一根落在「今天」前兩天,才不會被「資料太舊」的警告干擾要測的條件
    kw.setdefault("start", (datetime(2025, 3, 1) - timedelta(days=n + 1)).strftime("%Y-%m-%d"))
    series, stats = fp.build_series(fp.parse_chart(payload(n, **kw)), "2025-03-01")
    return stats, fp.verdict(series, stats, "2025-03-01")


def test_clean_data_is_accepted_without_warning():
    stats, (ok, warn, reason) = check()
    assert ok and not warn and not reason and stats["stale_share"] == 0


def test_mostly_stale_closes_are_excluded():
    stats, (ok, warn, reason) = check(stale_every=2)                                # 50% 的 K 棒開收價完全相同
    assert stats["stale_share"] == pytest.approx(0.5, abs=0.01)
    assert not ok and "收盤價疑似過期" in reason


def test_some_stale_closes_are_accepted_with_a_warning():
    _, (ok, warn, reason) = check(stale_every=7)                                    # 約 14%
    assert ok and "收盤價可能過期" in warn and not reason


def test_boundaries_of_the_stale_thresholds():
    assert check(stale_every=3)[1][0] is False                                      # 33% → 排除
    assert check(stale_every=5)[1][0] is True                                       # 20% → 收錄(有警告)
    assert check(stale_every=5)[1][1] != ""
    assert check(stale_every=25)[1][1] == ""                                        # 4% → 不警告


def test_too_few_bars_excluded_and_old_data_warned():
    assert check(n=100)[1][0] is False and "至少需要" in check(n=100)[1][2]
    _, (ok, warn, _) = check(start="2023-01-02", n=300)                             # 最新一根早在 2024 年
    assert ok and "距今" in warn


# --- 下載與重試 -----------------------------------------------------------------

def test_fetch_retries_on_429_and_gives_up():
    sleeps = []

    class Sequence:
        """依序回應: 429 → 連線錯誤(拋出例外)→ 成功"""
        def __init__(self):
            self.steps = [Resp(429), requests.ConnectionError("x"), Resp(200, {"ok": 1})]

        def get(self, *a, **k):
            step = self.steps.pop(0)
            if isinstance(step, Exception):
                raise step
            return step

    assert fp.fetch_chart(Sequence(), "SPY", 5, NOW, sleep=sleeps.append) == {"ok": 1} and sleeps == [1, 2]
    with pytest.raises(fp.FetchError, match="重試"):
        fp.fetch_chart(FakeSession(default=Resp(503)), "SPY", 5, NOW, sleep=lambda x: None)
    with pytest.raises(fp.FetchError, match="404"):
        fp.fetch_chart(FakeSession(default=Resp(404)), "SPY", 5, NOW, sleep=lambda x: None)


def test_request_encodes_symbol_and_asks_for_adjusted_close():
    s = FakeSession(default=payload(5))
    fp.fetch_chart(s, "BTC-USD", 10, NOW)
    symbol, params = s.calls[0]
    assert symbol == "BTC-USD" and params["includeAdjustedClose"] == "true" and params["interval"] == "1d"
    assert params["period2"] > params["period1"] and (params["period2"] - params["period1"]) > 10 * 365 * 86400


# --- 整體流程 -------------------------------------------------------------------

def universe_file(tmp_path, ids):
    p = tmp_path / "universe.json"
    p.write_text(json.dumps([{"id": i, "name": f"名稱 {i}", "category": "測試"} for i in ids]), encoding="utf-8")
    return p


def run_main(tmp_path, ids, by_symbol):
    out = tmp_path / "out"
    code = fp.main(["--out", str(out), "--universe", str(universe_file(tmp_path, ids)), "--pause", "0"],
                   session=FakeSession(by_symbol), now=NOW, sleep=lambda x: None)
    return code, out


def test_main_writes_prices_and_universe_and_excludes_bad_symbols(tmp_path):
    good = payload(400, start="2025-01-02")
    by = {"SPY": good, "2330.TW": payload(400, start="2025-01-02", hour_utc=1, offset=28800), "BTC-USD": good,
          "FAKE": payload(400, start="2025-01-02", stale_every=2), "BROKEN": Resp(404)}
    code, out = run_main(tmp_path, ["SPY", "2330.TW", "BTC-USD", "FAKE", "BROKEN"], by)
    assert code == 0
    uni = json.loads((out / "universe.json").read_text(encoding="utf-8"))
    assert uni["source"].startswith("Yahoo Finance")                              # 網站頁尾會顯示資料來源
    assert [a["id"] for a in uni["assets"]] == ["SPY", "2330.TW", "BTC-USD"]
    assert {s["id"] for s in uni["skipped"]} == {"FAKE", "BROKEN"}
    assert uni["assets"][1]["name"] == "名稱 2330.TW" and uni["assets"][0]["n"] > 300
    for sym in ("SPY", "2330.TW", "BTC-USD"):
        data = json.loads((out / "prices" / f"{sym}.json").read_text(encoding="utf-8"))
        assert data["adjusted"] is True and data["symbol"] == sym
        assert all(len(data[k]) == len(data["d"]) for k in "ohlcv")
        assert data["d"] == sorted(data["d"]) and data["d"][-1] < "2026-10-29"
    assert not (out / "prices" / "FAKE.json").exists()


def test_main_fails_when_fewer_than_half_pass(tmp_path):
    by = {"A": payload(400, start="2025-01-02")}
    code, out = run_main(tmp_path, ["A", "B", "C"], by)                              # B、C 沒有回應 → 404
    assert code == 1
    assert [a["id"] for a in json.loads((out / "universe.json").read_text(encoding="utf-8"))["assets"]] == ["A"]


def test_shipped_universe_file_is_valid():
    import pathlib
    items = json.loads((pathlib.Path(fp.__file__).with_name("universe.json")).read_text(encoding="utf-8"))
    ids = [i["id"] for i in items]
    assert len(ids) == len(set(ids)) >= 15
    assert all(i["name"] and i["category"] for i in items)
    assert {"SPY", "2330.TW", "BTC-USD"} <= set(ids)


# 網站端 priceFileName() 用同一張對照表測試(tests-js/strategy_data.test.js)
FILENAME_CASES = {"SPY": "SPY", "BRK-B": "BRK-B", "2330.TW": "2330.TW", "^VIX": "_5eVIX", "CL=F": "CL_3dF", "A_B": "A_5fB", "X^Y": "X_5eY", "X_5eY": "X_5f5eY"}


def test_price_filenames_never_need_url_encoding_and_never_collide():
    for sym, name in FILENAME_CASES.items():
        assert fp.price_filename(sym) == name
    assert len({fp.price_filename(s) for s in FILENAME_CASES}) == len(FILENAME_CASES)


def test_main_writes_special_symbols_under_safe_filenames(tmp_path):
    good = payload(400, start="2025-01-02")
    code, out = run_main(tmp_path, ["SPY", "^VIX", "CL=F"], {"SPY": good, "^VIX": good, "CL=F": good})
    assert code == 0
    assert sorted(p.name for p in (out / "prices").iterdir()) == ["CL_3dF.json", "SPY.json", "_5eVIX.json"]
    assert json.loads((out / "prices" / "_5eVIX.json").read_text(encoding="utf-8"))["symbol"] == "^VIX"
