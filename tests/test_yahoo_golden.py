"""tests-js/fixtures/yahoo_*.json 要和 Python 版的清理邏輯同步: JS 版拿它們當標準答案(見 tests/yahoo_cases.py)。"""
import json

from tests import yahoo_cases as yc


def test_payload_fixtures_are_current():
    payloads, _ = yc.build()
    assert json.loads((yc.FIXTURES / "yahoo_payloads.json").read_text(encoding="utf-8")) == json.loads(json.dumps(payloads))


def test_golden_matches_python_implementation():
    _, golden = yc.build()
    assert json.loads((yc.FIXTURES / "yahoo_golden.json").read_text(encoding="utf-8")) == json.loads(json.dumps(golden)), \
        "tools/fetch_prices.py 的清理結果變了: 執行 python tests/yahoo_cases.py --write,並確認 JS 版(tools/yahoo.mjs)跟著改"


def test_cases_cover_the_interesting_paths():
    _, golden = yc.build()
    assert golden["plain"]["ok"] and golden["dividend_adjusted"]["ok"]
    assert golden["nulls_nonpositive_repairs"]["stats"]["null"] == 3 and golden["nulls_nonpositive_repairs"]["stats"]["nonpositive"] == 2
    assert golden["nulls_nonpositive_repairs"]["stats"]["repaired"] >= 3
    assert golden["partial_today_and_duplicate_day"]["stats"]["partial_dropped"] == 1
    assert golden["duplicate_local_day"]["stats"]["duplicates"] == 1
    assert golden["stale_one_eighth"]["warn"].startswith("12%"), golden["stale_one_eighth"]["warn"]   # 12.5% → 進位到偶數
    assert not golden["stale_excluded"]["ok"] and "疑似過期" in golden["stale_excluded"]["reason"]
    assert golden["stale_warn_only"]["ok"] and "可能過期" in golden["stale_warn_only"]["warn"]
    assert not golden["too_few_bars"]["ok"]
    assert "距今" in golden["old_last_bar"]["warn"]
    assert "error" in golden["empty"] and "error" in golden["yahoo_error"]
    ties = golden["btc_ties"]["series"]["c"][:6]
    assert ties[:4] == [100000.0, 100002.0, 100002.0, 100004.0], ties                                 # 正中間的 6 位有效數字: 進位到偶數


def test_boundary_cases():
    _, g = yc.build()
    assert g["stale_exactly_quarter"]["ok"] and g["stale_exactly_quarter"]["warn"].startswith("25%")     # 剛好 25%: 收錄
    assert g["stale_exactly_five_percent"]["ok"] and g["stale_exactly_five_percent"]["warn"] == ""       # 剛好 5%: 不警告
    assert g["bars_250"]["ok"] and not g["bars_249"]["ok"]
    assert g["age_exactly_10_days"]["ok"] and g["age_exactly_10_days"]["warn"] == ""
    assert "距今 11 天" in g["age_11_days"]["warn"]
    assert g["flat_bars"]["ok"] and g["flat_bars"]["stats"]["stale_share"] == 0                           # 一字線不是「收盤價過期」
    assert g["asia_offset"]["series"]["d"][0] != g["west_offset_previous_day"]["series"]["d"][0]
