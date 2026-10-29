# Python 策略資料夾

把用 Python 寫的策略放在這裡,網站的「策略 → Python 策略」就會列出來。範本:`_template.py`;範例:`example_sma_cross.py`(事件模式)、`example_trend_filter.py`(部位模式)。
約定、偷看未來的檢查與疑難排解見專案根目錄 README 的「用 Python 寫策略」。

- 檔名去掉 `.py` 就是策略 id(只能用英數字、底線、連字號);底線開頭的檔案不會列在清單裡(可以放輔助模組或範本)。
- **你自己的策略檔預設不會被 git 追蹤**(見 `.gitignore`),避免把研究中的策略不小心推上公開的 repo;範例與範本會被追蹤。
- 這些檔案會以你的身分在你的電腦上執行(和你自己在終端機跑 python 一樣),不要放來路不明的檔案。
- 想直接用你研究專案裡的資料夾:`node tools/serve.mjs site 8080 --strategies /path/to/your/strategies`。
