import re
from pathlib import Path

import yaml

WF = yaml.safe_load(Path(".github/workflows/pages.yml").read_text(encoding="utf-8"))


def test_pages_workflow_is_manual_only_until_pages_is_enabled():
    triggers = WF.get("on", WF.get(True))
    assert list(triggers) == ["workflow_dispatch"]                    # 沒開啟 Pages 時 push / 排程只會天天失敗,所以只允許手動
    assert "if" not in WF["jobs"]["deploy"]


def test_pages_workflow_permissions_and_steps():
    assert WF["permissions"] == {"contents": "read", "pages": "write", "id-token": "write"}
    steps = WF["jobs"]["deploy"]["steps"]
    uses = [s.get("uses", "").split("@")[0] for s in steps]
    for needed in ("actions/checkout", "actions/configure-pages", "actions/upload-pages-artifact", "actions/deploy-pages"):
        assert needed in uses
    commands = " ".join(s.get("run", "") for s in steps)
    assert "tools/fetch_prices.py --out site/data" in commands
    # 抓資料必須在上傳之前,否則發布出去的網站沒有資料
    runs = [s.get("run", "") for s in steps]
    assert next(i for i, r in enumerate(runs) if "fetch_prices" in r) < uses.index("actions/upload-pages-artifact")
    upload = next(s for s in steps if s.get("uses", "").startswith("actions/upload-pages-artifact"))
    assert upload["with"]["path"] == "site"
    assert WF["jobs"]["deploy"]["environment"]["name"] == "github-pages"
    assert WF["concurrency"]["cancel-in-progress"] is False


def test_site_data_directory_is_not_committed():
    assert re.search(r"^site/data/$", Path(".gitignore").read_text(encoding="utf-8"), re.M)


def test_verify_data_workflow_is_manual_and_read_only():
    wf = yaml.safe_load(Path(".github/workflows/verify-data.yml").read_text(encoding="utf-8"))
    triggers = wf.get("on", wf.get(True))
    assert list(triggers) == ["workflow_dispatch"]
    assert wf["permissions"] == {"contents": "read"}
    commands = " ".join(s.get("run", "") for s in wf["jobs"]["verify"]["steps"])
    assert "fetch_prices.py" in commands and "verify_prices.py" in commands
    assert "git push" not in commands and "git commit" not in commands


def test_live_fetch_check_workflow_is_read_only_and_runs_both_comparisons():
    wf = yaml.safe_load(Path(".github/workflows/live-fetch-check.yml").read_text(encoding="utf-8"))
    assert wf["permissions"] == {"contents": "read"}
    commands = " ".join(s.get("run", "") for j in wf["jobs"].values() for s in j["steps"])
    assert "live_dump_python.py" in commands and "live_check.mjs" in commands and "live_e2e.mjs" in commands
    assert "git push" not in commands and "git commit" not in commands
