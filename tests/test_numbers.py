import json
from scripts.check_numbers import check


def test_number_checker_detects_stale_document_and_export(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "results/runs").mkdir(parents=True)
    (tmp_path / "README.md").write_text("{{result:runs.demo.summary.revenue_usd=50}}", encoding="utf-8")
    (tmp_path / "results/summary.json").write_text(json.dumps({"runs": {"demo": {"summary": {"revenue_usd": 50}}}}))
    export = tmp_path / "results/runs/demo.json"
    export.write_text(json.dumps({"summary": {"revenue_usd": 50}}))
    assert check(tmp_path) == ([], 1)
    (tmp_path / "docs/report.md").write_text("{{result:runs.demo.summary.revenue_usd=51}}", encoding="utf-8")
    assert len(check(tmp_path)[0]) == 1
    export.write_text(json.dumps({"summary": {"revenue_usd": 52}}))
    assert len(check(tmp_path)[0]) == 2
