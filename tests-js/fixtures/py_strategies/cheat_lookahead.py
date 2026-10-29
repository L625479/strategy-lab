"""測試用: 偷看明天的收盤(未來資料)。網站必須警告。"""
NAME = "測試: 偷看未來"


def run(df, params):
    return (df["close"].shift(-1) > df["close"]).astype(int)
