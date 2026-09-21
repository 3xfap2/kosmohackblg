import copy
import json
from pathlib import Path
import subprocess
import sys

import pytest
from core import service
from core.errors import InputError, NotFound
from core.analysis import impossibility
from model.resource_env import load
from test_planner import tiny


def fresh(algorithm="edf-baseline"):
    return service.create_run({"inline": tiny()}, "priority", algorithm)


def roundtrip(record):
    return json.loads(json.dumps(record))


@pytest.mark.parametrize("algorithm", ["edf-baseline", "horizon-cpsat"])
def test_chunked_equals_continuous(algorithm):
    start = fresh(algorithm)
    original = copy.deepcopy(start)
    whole = service.advance(start, 3)
    chunk = start
    for step in (1, 2, 3):
        chunk = service.advance(roundtrip(chunk), step)
    assert chunk == whole
    assert start == original
    assert service.view(whole)["summary"]["revenue_usd"] == 50
    assert service.view(start)["kpi"]["utilization"] is None


def event(at=0, identifier="E"):
    return {"id": identifier, "at_step": at, "type": "satellite_outage", "satellite_ids": ["S"], "end_step": 3}


@pytest.mark.parametrize("payload", [None, [], "{broken json", {}, event(-1), event(1),
    {**event(), "satellite_ids": ["S", "bad"]}])
def test_rejected_event_atomic(payload):
    start = fresh()
    saved = copy.deepcopy(start)
    changed, error = service.apply_event(start, payload)
    assert error
    assert start == saved
    assert changed["rejected_events"][-1]["payload"] == payload
    assert service.export(changed) == service.export(start)
    assert changed["planner_state"] == start["planner_state"]


def test_duplicate_and_partial_job_event():
    start = fresh()
    changed, error = service.apply_event(start, event())
    assert error is None
    duplicate, error = service.apply_event(changed, event())
    assert error and service.export(changed) == service.export(duplicate)
    valid = {**tiny()["jobs"][0], "id": "NEW"}
    partial, error = service.apply_event(start, {"id": "ADD", "at_step": 0, "type": "add_jobs",
        "jobs": [valid, {**valid, "id": "INVALID", "eligible_satellites": ["missing"]}]})
    assert error and service.export(partial) == service.export(start)


@pytest.mark.parametrize("algorithm", ["edf-baseline", "horizon-cpsat"])
def test_fork_goal_events_and_export(algorithm, tmp_path):
    parent = service.advance(fresh(algorithm), 1)
    saved = copy.deepcopy(parent)
    child = service.fork(roundtrip(parent), goal="revenue")
    assert parent == saved and child["id"] != parent["id"]
    assert child["commands"] == parent["commands"]
    assert child["run_metadata"]["goal_history"][-1] == {"step": 1, "goal": "revenue"}
    child, error = service.apply_event(child, event(1))
    assert error is None
    a, b = service.advance(parent, 3), service.advance(child, 3)
    assert service.view(a)["summary"]["jobs_completed"] == 1
    assert service.view(b)["summary"]["jobs_completed"] == 0
    assert parent == saved
    comparison = service.compare(a, b)
    assert comparison["same_origin"] and not comparison["same_events_after_fork"]
    assert comparison["verdict"]["preferred"] == "comparable"
    export = service.export(b)
    assert "trace" not in export
    assert service.replay(export)["match"]
    path, output = tmp_path / "record.json", tmp_path / "replayed.json"
    path.write_text(json.dumps(export), encoding="utf-8")
    subprocess.run([sys.executable, "-B", "model/operations.py", "--result", str(path), "--output", str(output)], check=True, capture_output=True)
    assert json.loads(output.read_text(encoding="utf-8"))["summary"] == export["summary"]
    assert service.replay(service.export(b, True))["match"]


def test_fork_preserves_plan_cache():
    parent = service.advance(fresh("horizon-cpsat"), 1)
    child = service.fork(roundtrip(parent))
    assert child["planner_state"] == parent["planner_state"]
    assert service.advance(parent, 3)["commands"] == service.advance(child, 3)["commands"]
    child["planner_state"]["plan"].clear()
    assert parent["planner_state"]["plan"]


def test_goal_only_changes_future_and_invalid_inputs():
    parent = service.advance(fresh(), 1)
    goal = service.set_goal(parent, "revenue")
    assert parent["run_metadata"]["goal"] == "priority"
    assert service.export(goal)["commands"] == service.export(parent)["commands"]
    for bad in (-1, 4, True, 1.5):
        with pytest.raises(InputError):
            service.advance(parent, bad)
    with pytest.raises(InputError):
        service.set_goal(parent, "bad")
    with pytest.raises(InputError):
        service.inspect_scenario({"inline": tiny(), "overrides": {"solar_factor": 0}})


def test_scenario_overrides_and_hash():
    source = {"inline": tiny(), "overrides": {"solar_factor": 0.4, "initial_soc_pct": {"S": 38}, "job_priority": {"J": 1}}}
    saved = copy.deepcopy(source)
    a = service.create_run(source, "priority", "edf-baseline")
    b = service.create_run(source, "priority", "edf-baseline")
    assert a["scenario_hash"] == b["scenario_hash"] and source == saved
    result = service.export(a)
    assert result["initial_scenario"]["satellites"][0]["initial_soc_pct"] == 38
    a["scenario_hash"] = "forged"
    with pytest.raises(InputError):
        service.view(a)
    with pytest.raises(NotFound):
        service.inspect_scenario({"ref": "../secret"})


def test_proof_and_views():
    s = load("data/P02_shift.json")
    j = next(j for j in s["jobs"] if j["id"] == "JOB-0007")
    proof = impossibility(s, j)
    assert proof["code"] == "insufficient_contact_steps"
    assert "1 шагов" in proof["proof"]
    r = service.advance(fresh(), 3)
    assert service.jobs(r)[0]["status"] == "completed"
    assert service.trace(r, 0, 3)[0]["soc_after_pct"] == 99
    assert service.explain(r, job_id="J")["constraint"] is None
    assert service.explain(r, satellite_id="S", step=0)["subject"]["step"] == 0


def test_explanation_does_not_see_future_events():
    r = service.advance(fresh(), 1)
    r, _ = service.apply_event(r, event(1))
    r = service.advance(r, 3)
    explanation = service.explain(r, satellite_id="S", step=0)
    assert "Получено сообщений: 0" in explanation["known_at_decision"][1]


def test_replay_reports_tampering():
    result = service.export(service.advance(fresh(), 3), True)
    result["summary"]["revenue_usd"] = 999
    assert not service.replay(result)["match"]
    assert "summary" in service.replay(result)["diff"]


def test_budget_splits_without_changing_commands(monkeypatch):
    r = fresh("horizon-cpsat")
    whole = service.advance(r, 3)
    ticks = iter([0.0, 1.0])
    with monkeypatch.context() as patch:
        patch.setattr(service.time, "monotonic", lambda: next(ticks))
        chunk = service.advance(r, 3, budget_s=0.5)
    assert chunk["steps_executed"] == 1
    assert service.advance(chunk, 3)["commands"] == whole["commands"]


def test_comparison_checks_boundary_state():
    a = service.advance(fresh(), 1)
    b = service.fork(a)
    # Та же исходная модель, но подмена выполненного префикса меняет физическое состояние.
    b["commands"] = []
    comparison = service.compare(a, b)
    assert not comparison["same_origin"]


@pytest.mark.parametrize("path", sorted(Path("data").glob("*.json")), ids=lambda p: p.stem)
def test_all_scenarios_official_cli_replay(path, tmp_path):
    r = service.create_run({"ref": path.stem}, "priority", "edf-baseline")
    r = service.advance(r, service.inspect_scenario({"ref": path.stem})["steps"])
    exported = service.export(r)
    saved, restored = tmp_path / "run.json", tmp_path / "replay.json"
    saved.write_text(json.dumps(exported), encoding="utf-8")
    subprocess.run([sys.executable, "-B", "model/operations.py", "--result", str(saved), "--output", str(restored)], check=True, capture_output=True)
    assert json.loads(restored.read_text(encoding="utf-8"))["summary"] == exported["summary"]
    assert exported["summary"]["blocked_command_count"] == 0


def test_timeline_matches_trace_and_is_compact():
    r = service.advance(fresh(), 3)
    timeline = service.timeline(r)
    assert timeline["action"] == ["rr."]
    assert timeline["job"] == [["J", "J", None]]
    assert timeline["soc"] == [[99, 98, 98]]
    assert timeline["dark"] == ["111"]
    assert timeline["steps_executed"] == 3
    assert len(json.dumps(timeline)) < len(json.dumps(service.trace(r, 0, 3)))


@pytest.mark.parametrize("field,value", [("notes", {"bad": []}), ("planner_state", []),
    ("run_metadata", {}), ("events", "bad"), ("commands", None)])
def test_invalid_record_returns_input_error(field, value):
    r = fresh()
    r[field] = value
    with pytest.raises(InputError):
        service.view(r)
