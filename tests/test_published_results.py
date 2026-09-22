"""Опубликованные результаты проверяемы: каждая сохранённая выгрузка повторяется официальной моделью,
файлы совпадают с манифестом SHA-256, числа в README.md и CRITERIA.md совпадают с results/*.json."""
import hashlib
import json
from pathlib import Path

import pytest

from model.operations import digest, replay_episode
from scripts.check_numbers import check

ROOT = Path(__file__).resolve().parents[1]
RUNS = sorted((ROOT / "results" / "runs").glob("*.json"))
SUMMARY = json.loads((ROOT / "results" / "summary.json").read_text(encoding="utf-8"))["runs"]


def test_every_summary_row_has_saved_run():
    assert {p.stem for p in RUNS} >= set(SUMMARY), "в results/runs нет части выгрузок из summary.json"


@pytest.mark.parametrize("path", RUNS, ids=lambda p: p.stem)
def test_saved_run_replays_with_official_model(path):
    record = json.loads(path.read_text(encoding="utf-8"))
    session = replay_episode(record["initial_scenario"], record["events"], record["commands"], record["steps_executed"])
    assert session.summary() == record["summary"]
    assert session.env.trace == record["trace"]
    row = SUMMARY.get(path.stem)
    if row:
        assert row["summary"] == record["summary"]
        assert row["command_hash"] == digest(record["commands"])


def test_manifest_matches_files():
    manifest = (ROOT / "results" / "MANIFEST.sha256").read_text(encoding="utf-8").split("\n")
    listed = dict(reversed(line.split("  ", 1)) for line in manifest if line)
    assert set(listed) == {f"runs/{p.name}" for p in RUNS}
    for p in RUNS:
        assert hashlib.sha256(p.read_bytes()).hexdigest() == listed[f"runs/{p.name}"], p.name


def test_inputs_match_manifest():
    """Результаты получены на неизменённой модели организаторов и тех же сценариях."""
    lines = (ROOT / "results" / "INPUTS.sha256").read_text(encoding="utf-8").split("\n")
    listed = dict(reversed(line.split("  ", 1)) for line in lines if line)
    assert {"model/operations.py", "model/resource_env.py", "data/P02_shift.json"} <= set(listed)
    for name, sha in listed.items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == sha, name


def test_published_numbers_match_results():
    errors, count = check()
    assert count >= 17 and not errors, errors


@pytest.mark.parametrize("scenario", ["P02_shift", "P03_energy", "P04_demand"])
def test_revenue_goal_not_below_priority_for_every_algorithm(scenario):
    """Цель «Коммерческая отдача» приносит не меньше выручки, чем «Приоритетное обслуживание», у эвристики и CP-SAT."""
    for algorithm in ("goal-greedy", "horizon-cpsat"):
        rev = SUMMARY[f"{scenario}__{algorithm}__revenue"]["summary"]["revenue_usd"]
        pri = SUMMARY[f"{scenario}__{algorithm}__priority"]["summary"]["revenue_usd"]
        assert rev >= pri, (algorithm, rev, pri)
