"""在網站的回測裡執行「用 Python 寫的策略」。由本機伺服器(tools/pyapi.mjs)以子行程呼叫,不需要手動執行。

    python tools/py_runner.py list <策略資料夾>
    python tools/py_runner.py run  <策略資料夾> <策略 id>      # 從 stdin 讀 JSON、把結果以 JSON 印到 stdout

策略是資料夾裡的一個 .py 檔(id = 檔名去掉 .py),約定如下(完整說明與範例見 README「用 Python 寫策略」與 strategies_py/):

    NAME = "我的策略"                       # 選用: 在網站上顯示的名稱
    PARAMS = {"fast": 12, "slow": 26}      # 選用: 預設參數,網站上會變成可以修改的欄位

    def run(df, params):
        # df: pandas.DataFrame,索引是日期(DatetimeIndex、由舊到新、無重複),欄位 open high low close volume(調整後價格)
        # 回傳(擇一),長度必須等於 len(df):
        #   1. 目標部位序列: +1 做多、0 空手、-1 放空。第 t 根收盤算出的部位,在第 t+1 根開盤成交(和網站的規則策略同一套成交假設)
        #   2. dict,可包含 "entry_long" "exit_long" "entry_short" "exit_short"(布林序列)與
        #      "stop_loss_pct" "take_profit_pct"(距離成交價的百分比序列,例如 5 = 5%,NaN = 不設)

回傳值裡的 NaN 代表「這根還沒有訊號」(例如指標還在暖機),那一根不會交易。
檢查未來資料: 預設會把資料截短(截到最後一根之前,以及幾個進場訊號為真的位置之後)再各跑一次,如果前面的訊號會因為後面的資料而改變,就警告「疑似偷看未來」。
策略裡 print 的內容不會弄壞輸出,會被收集起來回傳(最多 20,000 字)。
"""
import contextlib
import importlib.util
import io
import json
import math
import re
import sys
import time
import traceback
from pathlib import Path

ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,60}$")
EVENT_KEYS = ("entry_long", "exit_long", "entry_short", "exit_short")
STOP_KEYS = ("stop_loss_pct", "take_profit_pct")
LOG_LIMIT = 20000
MIN_BARS_FOR_LOOKAHEAD = 100


class StrategyError(Exception):
    """策略本身的問題(格式不對、執行出錯):訊息會原樣顯示在網站上。"""


def _need_pandas():
    try:
        import numpy as np  # noqa: F401
        import pandas as pd  # noqa: F401
    except ImportError as e:
        raise StrategyError(f"缺少套件 {e.name}。請先安裝: pip install pandas numpy") from e
    return np, pd


def strategy_path(folder, sid):
    if not ID_RE.match(sid or ""):
        raise StrategyError(f"策略 id「{sid}」不正確(只能用英數字、底線與連字號)")
    path = (Path(folder) / f"{sid}.py").resolve()
    if path.parent != Path(folder).resolve() or not path.is_file():
        raise StrategyError(f"找不到策略「{sid}」(應該是 {Path(folder)}/{sid}.py)")
    return path


def load_module(folder, sid):
    path = strategy_path(folder, sid)
    sys.path.insert(0, str(path.parent))                  # 策略可以 import 同一個資料夾裡的其他檔案
    spec = importlib.util.spec_from_file_location(f"strategy_{sid}", path)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except Exception as e:  # noqa: BLE001
        raise StrategyError(f"載入 {path.name} 失敗: {type(e).__name__}: {e}") from e
    if not callable(getattr(mod, "run", None)):
        raise StrategyError(f"{path.name} 裡沒有 run(df, params) 函式")
    return mod


def describe(folder):
    """列出資料夾裡每個策略: id、顯示名稱、說明、預設參數;載入失敗的會附上 error。"""
    out = []
    for path in sorted(Path(folder).glob("*.py")):
        sid = path.stem
        if not ID_RE.match(sid) or sid.startswith("_"):
            continue
        item = {"id": sid, "file": path.name, "name": sid, "doc": "", "params": []}
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                mod = load_module(folder, sid)
            item["name"] = str(getattr(mod, "NAME", sid))[:60]
            item["doc"] = (getattr(mod.run, "__doc__", None) or getattr(mod, "__doc__", None) or "").strip()[:600]
            params = getattr(mod, "PARAMS", {}) or {}
            if not isinstance(params, dict):
                raise StrategyError("PARAMS 必須是 dict")
            for k, v in params.items():
                if isinstance(v, bool) or not isinstance(v, (int, float, str)):
                    raise StrategyError(f"PARAMS[{k!r}] 只能是數字、布林或文字")
                item["params"].append({"name": str(k), "value": v})
        except StrategyError as e:
            item["error"] = str(e)
        out.append(item)
    return out


# ---- 輸出整理 ---------------------------------------------------------------------------

def _to_array(x, index, n, label, np, pd):
    """策略回傳的序列 → 長度 n 的 float ndarray。有日期索引的 Series 依日期對齊,其他依位置。"""
    if isinstance(x, pd.DataFrame):
        if x.shape[1] != 1:
            raise StrategyError(f"{label} 回傳了 {x.shape[1]} 欄的 DataFrame,需要單一序列")
        x = x.iloc[:, 0]
    if isinstance(x, pd.Series) and isinstance(x.index, pd.DatetimeIndex) and not x.index.equals(index):
        if x.index.has_duplicates:
            raise StrategyError(f"{label} 的日期索引有重複")
        x = x.reindex(index)
    try:
        arr = np.asarray(x, dtype=float).ravel()
    except (TypeError, ValueError) as e:
        raise StrategyError(f"{label} 不是數值序列({e})") from e
    if arr.shape[0] != n:
        raise StrategyError(f"{label} 的長度是 {arr.shape[0]},但資料有 {n} 根 K 棒,兩者必須相同")
    if np.isinf(arr).any():
        raise StrategyError(f"{label} 含有無限大(inf)")
    return arr


def normalize(result, df, np, pd):
    """策略的回傳值 → ({entry_long, exit_long, entry_short, exit_short: 0/1 list, stop_loss_pct, take_profit_pct: list|None}, valid, warnings, mode)。"""
    n, idx, warns = len(df), df.index, []
    nan_any = np.zeros(n, dtype=bool)
    out = {}
    if isinstance(result, dict):
        mode = "events"
        unknown = [k for k in result if k not in EVENT_KEYS + STOP_KEYS]
        if unknown:
            raise StrategyError(f"回傳的 dict 有不認得的鍵 {unknown};可用: {', '.join(EVENT_KEYS + STOP_KEYS)}")
        if not any(k in result for k in EVENT_KEYS):
            raise StrategyError("回傳的 dict 至少要有一個進場或出場訊號(entry_long / exit_long / entry_short / exit_short)")
        for k in EVENT_KEYS:
            if k in result:
                a = _to_array(result[k], idx, n, k, np, pd)
                nan_any |= np.isnan(a)
                out[k] = (np.nan_to_num(a, nan=0.0) != 0).astype(int)
            else:
                out[k] = np.zeros(n, dtype=int)
        for k in STOP_KEYS:
            if k in result and result[k] is not None:
                a = _to_array(result[k], idx, n, k, np, pd)
                if (a[~np.isnan(a)] <= 0).any():
                    raise StrategyError(f"{k} 必須大於 0(距離成交價的百分比,例如 5 代表 5%);不設的那幾根請用 NaN")
                out[k] = a
    else:
        mode = "positions"
        pos = _to_array(result, idx, n, "回傳的部位序列", np, pd)
        nan_any = np.isnan(pos)
        p = np.nan_to_num(pos, nan=0.0)
        if (np.abs(p) > 1 + 1e-9).any() or ((p != 0) & (np.abs(p) < 1 - 1e-9)).any():
            warns.append("部位的大小被忽略,只取方向(+1 做多 / 0 空手 / -1 放空)。回測分頁一次一個部位、固定比例投入;分數權重請用「目標權重」分頁。")
        s = np.sign(p)
        out["entry_long"], out["exit_long"] = (s > 0).astype(int), (s <= 0).astype(int)      # 目標部位: 空手時目標是多就進場、持有多單時目標不是多就出場
        out["entry_short"], out["exit_short"] = (s < 0).astype(int), (s >= 0).astype(int)
    for k in STOP_KEYS:
        out.setdefault(k, None)
    return out, (~nan_any).astype(int), warns, mode


def _eq(a, b):
    if a is None or b is None:
        return a is None and b is None
    import numpy as np
    return bool(np.allclose(a, b, equal_nan=True, rtol=1e-9, atol=1e-12))


def decision_cuts(out, n, count=6, skip=30):
    """截短的位置: 選在「進場訊號為真的那一根」之後(截到那一根為止)。偷看未來的策略,訊號通常就是靠未來的資料才為真;
    只隨便挑幾個位置的話,訊號剛好沒變就會漏抓。從進場訊號為真的根裡平均地挑 count 個(沒有進場訊號時改用出場訊號)。"""
    for keys in (("entry_long", "entry_short"), ("exit_long", "exit_short")):
        fired = [i for i in range(skip, n - 1) if any(out[k][i] for k in keys)]
        if fired:
            step = max(1, len(fired) // count)
            return [fired[j] + 1 for j in range(0, len(fired), step)][:count]
    return []


def check_lookahead(mod, df, params, full, np, pd):
    """把資料截短到前 k 根再跑一次: 前 k 根的訊號必須和完整資料跑出來的一樣,否則策略用到了未來的資料。"""
    n = len(df)
    if n < MIN_BARS_FOR_LOOKAHEAD:
        return {"checked": False, "reason": f"資料只有 {n} 根(少於 {MIN_BARS_FOR_LOOKAHEAD}),略過檢查"}
    full_out, full_valid = full
    cuts = sorted({n - 1} | set(decision_cuts(full_out, n)))                     # 倒數第二根(整段資料只少最後一根)+ 幾個進場訊號之後
    failed = []
    for k in cuts:
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                part = mod.run(df.iloc[:k].copy(), dict(params))
            part_out, part_valid, _, _ = normalize(part, df.iloc[:k], np, pd)
        except Exception as e:  # noqa: BLE001
            failed.append((k, f"{type(e).__name__}: {e}"))                    # 截短的資料太短,策略自己撐不住: 跳過這個位置,看其他位置
            continue
        for key in EVENT_KEYS + STOP_KEYS:
            a, b = full_out[key], part_out[key]
            if not _eq(None if a is None else a[:k], b):
                bad = (np.nonzero(~np.isclose(a[:k], b, equal_nan=True))[0] if a is not None and b is not None else np.array([0]))
                return {"checked": True, "ok": False, "key": key, "index": int(bad[0]), "cut": k,
                        "date": str(df.index[int(bad[0])].date())}
        if not np.array_equal(full_valid[:k], part_valid):
            bad = np.nonzero(full_valid[:k] != part_valid)[0]
            return {"checked": True, "ok": False, "key": "valid(NaN 的位置)", "index": int(bad[0]), "cut": k, "date": str(df.index[int(bad[0])].date())}
    if len(failed) == len(cuts):
        return {"checked": True, "ok": True, "inconclusive": f"截短到 {failed[0][0]} 根時執行失敗({failed[0][1]}),無法判斷"}
    return {"checked": True, "ok": True, "cuts": [k for k in cuts if k not in {f[0] for f in failed}], "skipped": [f[0] for f in failed]}


def _jsonable(a):
    if a is None:
        return None
    return [None if (isinstance(x, float) and math.isnan(x)) else (x.item() if hasattr(x, "item") else x) for x in a.tolist()]


def run_strategy(folder, sid, payload):
    np, pd = _need_pandas()
    bars = payload["bars"]
    n = len(bars["d"])
    if n < 2 or any(len(bars[k]) != n for k in ("o", "h", "l", "c")):
        raise StrategyError("資料格式不正確(需要等長的 d / o / h / l / c)")
    df = pd.DataFrame({"open": bars["o"], "high": bars["h"], "low": bars["l"], "close": bars["c"], "volume": bars.get("v") or [0] * n},
                      index=pd.DatetimeIndex(pd.to_datetime(bars["d"]), name="date"))
    if not df.index.is_monotonic_increasing or df.index.has_duplicates:
        raise StrategyError("資料的日期必須由舊到新且不重複")
    mod = load_module(folder, sid)
    params = {}
    declared = getattr(mod, "PARAMS", {}) or {}
    params.update(declared)
    for k, v in (payload.get("params") or {}).items():
        if k not in declared:
            raise StrategyError(f"參數「{k}」不在這個策略的 PARAMS 裡(可用: {', '.join(declared) or '無'})")
        params[k] = v
    log = io.StringIO()
    t0 = time.time()
    try:
        with contextlib.redirect_stdout(log):
            result = mod.run(df.copy(), dict(params))
    except StrategyError:
        raise
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc().strip().splitlines()
        raise StrategyError(f"策略執行時出錯: {type(e).__name__}: {e}\n" + "\n".join(tb[-6:])) from e
    out, valid, warns, mode = normalize(result, df, np, pd)
    lookahead = {"checked": False, "reason": "已關閉檢查"}
    if payload.get("check_lookahead", True):
        lookahead = check_lookahead(mod, df, params, (out, valid), np, pd)
    text = log.getvalue()
    return {
        "ok": True, "mode": mode, "n": n, "seconds": round(time.time() - t0, 3), "warnings": warns, "lookahead": lookahead,
        "log": text[:LOG_LIMIT] + ("\n…(輸出太長,已截斷)" if len(text) > LOG_LIMIT else ""),
        "signals": {k: _jsonable(v) for k, v in out.items()}, "valid": valid.tolist(),
    }


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    try:
        if cmd == "list":
            result = {"ok": True, "strategies": describe(argv[2])}
        elif cmd == "run":
            result = run_strategy(argv[2], argv[3], json.loads(sys.stdin.read()))
        else:
            result = {"ok": False, "error": __doc__.split("\n")[0]}
    except StrategyError as e:
        result = {"ok": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        result = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-2000:]}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
