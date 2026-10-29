import re
from pathlib import Path

import yaml

WF = yaml.safe_load(Path(".github/workflows/pages.yml").read_text(encoding="utf-8"))


def test_pages_workflow_triggers():
    triggers = WF.get("on", WF.get(True))
    assert {"workflow_dispatch", "push", "schedule"} <= set(triggers)
    assert triggers["push"]["branches"] == ["main"] and any(p.startswith("site/") for p in triggers["push"]["paths"])
    assert "if" not in WF["jobs"]["deploy"]                          # 公開 repo: 不需要啟用開關,push 與排程都會部署


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
