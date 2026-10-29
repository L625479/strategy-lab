"""策略範本: 複製這個檔案、改名(檔名去掉 .py 就是策略 id,不能以底線開頭),再改下面的 run()。

約定(完整說明見 README「用 Python 寫策略」):
  - df 是 pandas.DataFrame,索引是日期(由舊到新),欄位 open high low close volume(調整後價格)。
  - 第 t 根只能用「第 t 根(含)以前」的資料。網站預設會截短資料重跑一次來檢查,如果前面的訊號被後面的資料改變,就會警告你偷看了未來。
  - 第 t 根收盤算出的訊號,在第 t+1 根開盤成交(和網站內建的規則策略同一套成交假設)。
  - 回傳長度和 df 一樣的結果,二選一:
      1. 目標部位序列: +1 做多 / 0 空手 / -1 放空(要允許做空,請在網站上勾選「允許做空」)
      2. dict: {"entry_long": 布林序列, "exit_long": ..., "entry_short": ..., "exit_short": ...,
                "stop_loss_pct": 距離成交價的百分比序列(5 = 5%), "take_profit_pct": ...}  需要哪個放哪個
  - NaN 代表「這根還沒有訊號」(例如指標還在暖機),那一根不會交易。
  - 手續費、滑價、投入比例、止損止盈(固定百分比 / ATR 倍數)仍然在網站上設定;你的策略只負責「什麼時候進出」。
"""
NAME = "我的策略"          # 選用: 在網站上顯示的名稱
PARAMS = {"n": 20}        # 選用: 預設參數,網站上會變成可以修改的欄位(數字、布林或文字)


def run(df, params):
    ma = df["close"].rolling(int(params["n"])).mean()
    pos = (df["close"] > ma).astype(float)
    pos[ma.isna()] = float("nan")
    return pos
