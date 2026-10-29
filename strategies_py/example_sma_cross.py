"""示範(事件模式): 快線由下往上穿過慢線就做多,由上往下穿過就出場。和網站內建規則 cross_above(sma(close, fast), sma(close, slow)) 是同一個邏輯。"""
NAME = "範例: SMA 交叉(事件模式)"
PARAMS = {"fast": 10, "slow": 30}


def run(df, params):
    fast = df["close"].rolling(int(params["fast"])).mean()
    slow = df["close"].rolling(int(params["slow"])).mean()
    cross_up = (fast > slow) & (fast.shift(1) <= slow.shift(1))
    cross_dn = (fast < slow) & (fast.shift(1) >= slow.shift(1))
    return {"entry_long": cross_up, "exit_long": cross_dn}
