"""示範(部位模式): 收盤站上 n 日均線就持有多單,跌破就空手。回傳每一根的目標部位(+1 / 0 / -1),NaN 代表指標還在暖機。"""
NAME = "範例: 均線趨勢濾網(部位模式)"
PARAMS = {"n": 200}


def run(df, params):
    ma = df["close"].rolling(int(params["n"])).mean()
    pos = (df["close"] > ma).astype(float)         # 站上均線 = 1,否則 0
    pos[ma.isna()] = float("nan")                  # 均線還算不出來的那幾根: 沒有訊號,不交易
    return pos
