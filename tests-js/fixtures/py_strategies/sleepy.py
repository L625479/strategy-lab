import time

NAME = "測試: 睡 2 秒"


def run(df, params):
    time.sleep(2)
    return df["close"] * 0
