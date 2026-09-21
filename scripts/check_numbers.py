"""Проверяет сводку и явные числовые ссылки в Markdown.

Формат ссылки: {{result:runs.KEY.summary.revenue_usd=123.0}}.
Числа без таких ссылок не считаются автоматически проверенными.
"""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(r"\{\{result:([^=]+)=([^}]+)\}\}")


def check(root=ROOT):
    summary = json.loads((root / "results/summary.json").read_text(encoding="utf-8"))
    errors, count = [], 0
    for key, row in summary["runs"].items():
        record = json.loads((root / "results/runs" / (key + ".json")).read_text(encoding="utf-8"))
        if row["summary"] != record["summary"]:
            errors.append(f"{key}: сводка расходится с экспортом")
    for file in [root / "README.md", *sorted((root / "docs").glob("*.md")),
                 *sorted((root / "results").glob("*.md"))]:
        content = file.read_text(encoding="utf-8")
        for match in PATTERN.finditer(content):
            count += 1
            try:
                value = summary
                for part in match[1].split("."):
                    value = value[part]
                if value != json.loads(match[2]):
                    errors.append(f"{file.name}: не совпадает {match[1]}")
            except (KeyError, TypeError, ValueError):
                errors.append(f"{file.name}: неверная ссылка {match[0]}")
        if content.count("{{result:") != len(PATTERN.findall(content)):
            errors.append(f"{file.name}: некорректный маркер результата")
    return errors, count


if __name__ == "__main__":
    errors, count = check()
    for error in errors:
        print(error)
    print(f"Проверено числовых ссылок: {count}; ошибок: {len(errors)}")
    if not count:
        print("Числа в документах пока не размечены; их согласованность не подтверждена.")
    raise SystemExit(bool(errors))
