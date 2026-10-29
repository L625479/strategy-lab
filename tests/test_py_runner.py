"""tools/py_runner.py: 用 Python 寫的策略要怎麼被載入、執行、整理成訊號,以及「偷看未來」的檢查。"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

pd = pytest.importorskip("pandas")
RUNNER = Path(__file__).resolve().parent.parent / "tools" / "py_runner.py"

SMA_POS = '''
NAME = "SMA 部位"
PARAMS = {"fast": 5, "slow": 20}

def run(df, params):
    """快線在慢線之上就做多。"""
    f, s = df.close.rolling(params["fast"]).mean(), df.close.rolling(params["slow"]).mean()
    pos = (f > s).astype(float)
    pos[s.isna()] = float("nan")          # 暖機期間還沒有訊號
    return pos
'''

SMA_EVENTS = '''
NAME = "SMA 交叉(事件)"
PARAMS = {"fast": 5, "slow": 20}

def run(df, params):
    f, s = df.close.rolling(params["fast"]).mean(), df.close.rolling(params["slow"]).mean()
    up = (f > s) & (f.shift(1) <= s.shift(1))
    down = (f < s) & (f.shift(1) >= s.shift(1))
    return {"entry_long": up, "exit_long": down}
'''

CHEAT = '''
def run(df, params):
    return (df.close.shift(-1) > df.close).astype(int)        # 用明天的收盤: 偷看未來
'''

SOURCES = {
    "sma_pos": SMA_POS, "sma_events": SMA_EVENTS, "cheat": CHEAT,
    "prints": 'def run(df, params):\n    print("hello from strategy")\n    return df.close * 0 + 1\n',
    "bad_len": 'def run(df, params):\n    return [1, 0, 1]\n',
    "bad_keys": 'def run(df, params):\n    return {"entry": df.close > 0}\n',
    "only_stops": 'def run(df, params):\n    return {"stop_loss_pct": df.close * 0 + 5}\n',
    "boom": 'def run(df, params):\n    return df.nope\n',
    "inf": 'def run(df, params):\n    return df.close / 0\n',
    "big": 'def run(df, params):\n    return (df.close > df.close.mean()).astype(float) * 2\n',
    "stops": 'def run(df, params):\n    return {"entry_long": df.close > 0, "stop_loss_pct": df.close * 0 + 5, "take_profit_pct": df.close * float("nan") + 0}\n',
    "neg_stop": 'def run(df, params):\n    return {"entry_long": df.close > 0, "stop_loss_pct": df.close * 0 - 5}\n',
    "events_nan": 'def run(df, params):\n    ma = df.close.rolling(20).mean()\n    up = (df.close > ma).astype(float)\n    up[ma.isna()] = float("nan")\n    return {"entry_long": up, "exit_long": 1 - up}\n',
    "zero_stop": 'def run(df, params):\n    return {"entry_long": df.close > 0, "stop_loss_pct": df.close * 0}\n',
    "half_size": 'def run(df, params):\n    return df.close * 0 + 0.5\n',
    "late_cheat": 'def run(df, params):\n    pos = (df.close > df.close.rolling(10).mean()).astype(float)\n    cut = 210\n    peek = (df.close.shift(-1) > df.close).astype(float)\n    pos.iloc[cut:] = peek.iloc[cut:]\n    return pos\n',
    "nan_peek": 'def run(df, params):\n    return (df.close * 0).where(df.close.shift(-1).notna())\n',
    "stop_peek": 'def run(df, params):\n    return {"entry_long": df.close < 0, "stop_loss_pct": (df.close.shift(-1) / df.close - 1).abs() * 100 + 1}\n',
    "no_run": 'x = 1\n',
    "syntax": 'def run(df, params:\n',
    "bad_params": 'PARAMS = [1, 2]\ndef run(df, params):\n    return df.close * 0\n',
    "str_series": 'import pandas as pd\ndef run(df, params):\n    return pd.Series(["a"] * len(df), index=df.index)\n',
    "shifted_index": 'def run(df, params):\n    s = (df.close > 0).astype(int)\n    s.index = s.index + pd_offset\n    return s\n',
    "noisy_import": 'print("module level print")\nNAME = "noisy"\ndef run(df, params):\n    return df.close * 0\n',
    "_hidden": 'def run(df, params):\n    return df.close * 0\n',
    "param_types": 'PARAMS = {"n": 3, "x": 1.5, "mode": "fast"}\ndef run(df, params):\n    assert isinstance(params["mode"], str)\n    return df.close * 0 + params["n"]\n',
}


@pytest.fixture()
def folder(tmp_path):
    for name, src in SOURCES.items():
        (tmp_path / f"{name}.py").write_text(src, encoding="utf-8")
    (tmp_path / "helper_mod.py").write_text("VALUE = 7\n", encoding="utf-8")
    (tmp_path / "uses_helper.py").write_text("from helper_mod import VALUE\ndef run(df, params):\n    return df.close * 0 + (VALUE > 5)\n", encoding="utf-8")
    return tmp_path


def bars(n=400, seed=3):
    rng = np.random.default_rng(seed)
    c = 100 * np.exp(np.cumsum(rng.normal(0.0003, 0.012, n)))
    o = c * (1 + rng.normal(0, 0.003, n))
    h, l = np.maximum(o, c) * 1.004, np.minimum(o, c) * 0.996
    d = [str(x.date()) for x in pd.bdate_range("2022-01-03", periods=n)]
    return {"d": d, "o": o.tolist(), "h": h.tolist(), "l": l.tolist(), "c": c.tolist(), "v": [1000] * n}


def call(folder, *args, payload=None):
    p = subprocess.run([sys.executable, str(RUNNER), *args], input=json.dumps(payload) if payload is not None else "", capture_output=True, text=True, timeout=120)
    return json.loads(p.stdout), p


def run(folder, sid, **extra):
    return call(folder, "run", str(folder), sid, payload={"bars": bars(), **extra})[0]


def test_list_describes_every_strategy_and_reports_broken_ones(folder):
    out, _ = call(folder, "list", str(folder))
    by = {s["id"]: s for s in out["strategies"]}
    assert "_hidden" not in by and "helper_mod" in by, "底線開頭的不列出;其他 .py 都列(輔助模組也會列,沒有 run 的會標錯)"
    assert by["sma_pos"]["name"] == "SMA 部位" and by["sma_pos"]["doc"].startswith("快線在慢線之上")
    assert by["sma_pos"]["params"] == [{"name": "fast", "value": 5}, {"name": "slow", "value": 20}]
    assert by["param_types"]["params"] == [{"name": "n", "value": 3}, {"name": "x", "value": 1.5}, {"name": "mode", "value": "fast"}]
    assert by["prints"]["name"] == "prints" and by["prints"]["params"] == []
    assert "沒有 run(df, params)" in by["no_run"]["error"] and "helper_mod" in by
    assert "載入 syntax.py 失敗" in by["syntax"]["error"]
    assert "PARAMS 必須是 dict" in by["bad_params"]["error"]
    assert "error" not in by["sma_pos"]
    assert by["noisy_import"]["name"] == "noisy"


def test_positions_mode_turns_target_positions_into_level_signals(folder):
    r = run(folder, "sma_pos", check_lookahead=False)
    assert r["ok"] and r["mode"] == "positions" and r["n"] == 400
    s, v = r["signals"], r["valid"]
    assert v[:19] == [0] * 19 and v[19:] == [1] * 381, "慢線 20 根才有值,之前是 NaN → 不交易"
    df = pd.DataFrame(bars()); f, sl = df.c.rolling(5).mean(), df.c.rolling(20).mean()
    want = (f > sl).astype(int).tolist()
    assert s["entry_long"][19:] == want[19:] and s["exit_long"][19:] == [1 - x for x in want[19:]]
    assert s["entry_short"][19:] == [0] * 381 and s["exit_short"][19:] == [1] * 381, "沒有做空的部位: 持有空單時「目標不是空」就該出場"
    assert s["stop_loss_pct"] is None and s["take_profit_pct"] is None


def test_params_default_override_and_unknown_param(folder):
    a = run(folder, "sma_pos", check_lookahead=False)
    b = run(folder, "sma_pos", params={"fast": 3, "slow": 10}, check_lookahead=False)
    assert a["signals"]["entry_long"] != b["signals"]["entry_long"] and b["valid"][:9] == [0] * 9 and b["valid"][9] == 1
    r = run(folder, "sma_pos", params={"nope": 1})
    assert not r["ok"] and "參數「nope」不在這個策略的 PARAMS 裡" in r["error"]


def test_events_mode_passes_event_series_and_stops(folder):
    r = run(folder, "sma_events", check_lookahead=False)
    assert r["ok"] and r["mode"] == "events" and sum(r["signals"]["entry_long"]) > 3 and sum(r["signals"]["exit_long"]) > 3
    assert r["signals"]["entry_short"] == [0] * 400
    s = run(folder, "stops", check_lookahead=False)
    assert s["signals"]["stop_loss_pct"] == [5.0] * 400 and s["signals"]["take_profit_pct"] == [None] * 400, "NaN → null(不設)"


def test_output_validation_gives_clear_messages(folder):
    expect = {
        "bad_len": "長度是 3,但資料有 400 根", "bad_keys": "不認得的鍵", "only_stops": "至少要有一個進場或出場訊號",
        "inf": "無限大", "neg_stop": "stop_loss_pct 必須大於 0", "str_series": "不是數值序列", "boom": "策略執行時出錯: AttributeError",
        "no_run": "沒有 run(df, params) 函式", "syntax": "載入 syntax.py 失敗",
    }
    for sid, msg in expect.items():
        r = run(folder, sid)
        assert not r["ok"] and msg in r["error"], (sid, r)
    assert "df.nope" in run(folder, "boom")["error"] or "nope" in run(folder, "boom")["error"], "錯誤訊息帶出出錯的那一行附近"


def test_position_sizes_are_ignored_with_a_warning(folder):
    r = run(folder, "big", check_lookahead=False)
    assert r["ok"] and any("部位的大小被忽略" in w for w in r["warnings"])


def test_prints_are_captured_not_mixed_into_the_json(folder):
    r = run(folder, "prints", check_lookahead=False)
    assert r["ok"] and "hello from strategy" in r["log"]
    out, p = call(folder, "list", str(folder))
    assert out["ok"], "模組載入時的 print 不會弄壞 list 的輸出"


def test_sibling_modules_can_be_imported(folder):
    r = run(folder, "uses_helper", check_lookahead=False)
    assert r["ok"] and set(r["signals"]["entry_long"]) == {1}


def test_lookahead_check_catches_a_strategy_that_peeks_at_tomorrow(folder):
    honest = run(folder, "sma_pos")
    assert honest["lookahead"]["checked"] and honest["lookahead"]["ok"], honest["lookahead"]
    events = run(folder, "sma_events")
    assert events["lookahead"]["ok"]
    cheat = run(folder, "cheat")
    la = cheat["lookahead"]
    assert la["checked"] and la["ok"] is False and la["key"] in ("entry_long", "exit_long") and la["index"] >= 0 and "date" in la
    assert run(folder, "cheat", check_lookahead=False)["lookahead"] == {"checked": False, "reason": "已關閉檢查"}
    short = call(folder, "run", str(folder), "sma_pos", payload={"bars": {k: v[:60] for k, v in bars().items()}})[0]
    assert short["lookahead"]["checked"] is False and "少於 100" in short["lookahead"]["reason"]


def test_lookahead_check_is_inconclusive_not_failed_when_a_truncated_run_crashes(folder):
    (folder / "fragile.py").write_text("def run(df, params):\n    assert len(df) == 400\n    return df.close * 0 + 1\n", encoding="utf-8")
    r = run(folder, "fragile")
    assert r["ok"] and r["lookahead"]["ok"] and "無法判斷" in r["lookahead"]["inconclusive"]


def test_bad_inputs_are_rejected(folder):
    for sid, msg in (("../x", "不正確"), ("a/b", "不正確"), ("nope", "找不到策略"), ("", "不正確")):
        out, _ = call(folder, "run", str(folder), sid, payload={"bars": bars()})
        assert not out["ok"] and msg in out["error"], (sid, out)
    b = bars(); b["d"][5] = b["d"][4]
    out, _ = call(folder, "run", str(folder), "sma_pos", payload={"bars": b})
    assert "由舊到新且不重複" in out["error"]
    out, _ = call(folder, "run", str(folder), "sma_pos", payload={"bars": {"d": ["2024-01-02"], "o": [1], "h": [1], "l": [1], "c": [1]}})
    assert "資料格式不正確" in out["error"]
    out, p = call(folder, "bogus")
    assert not out["ok"] and p.returncode == 1


def test_series_with_a_date_index_is_aligned_by_date(folder):
    (folder / "dated.py").write_text("def run(df, params):\n    s = (df.close > df.close.mean()).astype(int)\n    return s.iloc[::-1]\n", encoding="utf-8")
    r = run(folder, "dated", check_lookahead=False)
    df = pd.DataFrame(bars()); want = (df.c > df.c.mean()).astype(int).tolist()
    assert r["ok"] and r["signals"]["entry_long"] == want, "反過來排的 Series 依日期索引對回去"


def test_nan_in_event_series_means_no_signal_yet(folder):
    r = run(folder, "events_nan", check_lookahead=False)
    assert r["ok"] and r["valid"][:19] == [0] * 19 and r["valid"][19:] == [1] * 381
    assert r["signals"]["entry_long"][:19] == [0] * 19


def test_zero_stop_distance_is_rejected_like_negative(folder):
    r = run(folder, "zero_stop")
    assert not r["ok"] and "stop_loss_pct 必須大於 0" in r["error"]


def test_half_positions_warn_that_the_size_is_ignored(folder):
    r = run(folder, "half_size", check_lookahead=False)
    assert r["ok"] and any("部位的大小被忽略" in w for w in r["warnings"])
    assert set(r["signals"]["entry_long"]) == {1}, "0.5 的部位視為做多"


def test_lookahead_check_also_catches_peeking_that_only_happens_late_in_the_data(folder):
    la = run(folder, "late_cheat")["lookahead"]
    assert la["checked"] and la["ok"] is False, la                                 # 第 210 根以前誠實、之後偷看
    assert la["index"] >= 200


def test_lookahead_check_detects_a_one_bar_peek_on_every_dataset(folder):
    """偷看「明天」的策略: 不論資料長怎樣都要抓得到(不是靠運氣剛好有一個截短的位置訊號變了)。"""
    sys.path.insert(0, str(RUNNER.parent))
    import py_runner as pr

    misses = []
    for seed in range(25):
        payload = {"bars": bars(n=300, seed=seed), "check_lookahead": True}
        for sid in ("cheat", "late_cheat", "nan_peek"):
            la = pr.run_strategy(str(folder), sid, payload)["lookahead"]
            if la.get("ok") is not False:
                misses.append((seed, sid, la))
        honest = pr.run_strategy(str(folder), "sma_events", payload)["lookahead"]
        assert honest["ok"] is True, (seed, honest)
    assert misses == [], misses


def test_lookahead_check_catches_peeking_that_only_shows_in_nan_positions(folder):
    la = run(folder, "nan_peek")["lookahead"]
    assert la["checked"] and la["ok"] is False and "valid" in la["key"], la


def test_lookahead_check_still_works_when_there_are_no_entry_or_exit_signals_at_all(folder):
    la = run(folder, "stop_peek")["lookahead"]
    assert la["checked"] and la["ok"] is False and la["key"] == "stop_loss_pct", la
