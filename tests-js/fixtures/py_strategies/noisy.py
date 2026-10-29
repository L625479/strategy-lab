NAME = "測試: 會 print"
PARAMS = {"level": 1, "label": "abc"}


def run(df, params):
    print("noisy says hi", params["label"])
    return df["close"] * 0 + 1
