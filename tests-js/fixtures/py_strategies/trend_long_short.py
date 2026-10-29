"""測試用(部位模式含做空): 收盤高於 n 日均線 = +1(做多),否則 -1(放空)。"""
NAME = "測試: 多空趨勢"
PARAMS = {"n": 40}


def run(df, params):
    ma = df["close"].rolling(int(params["n"])).mean()
    pos = (df["close"] > ma).astype(float) * 2 - 1
    pos[ma.isna()] = float("nan")
    return pos
