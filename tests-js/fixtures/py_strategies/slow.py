import time

NAME = "測試: 很慢"


def run(df, params):
    time.sleep(30)
    return df["close"] * 0
