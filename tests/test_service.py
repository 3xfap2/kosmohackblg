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
    assert comparison["verdict"]["preferred"] == "incomparable"      # разные сообщения после развилки
    assert comparison["verdict"]["by_goal"] == {"priority": "incomparable", "revenue": "incomparable"}
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
    # Подмена выполненного префикса: без подписи сервера запись не принимается вовсе…
    b["commands"] = []
    with pytest.raises(InputError, match="Подпись записи"):
        service.compare(a, b)
    # …а если бы подпись совпала, сравнение всё равно увидело бы разное состояние на развилке.
    comparison = service.compare(a, service._signed(b))
    assert not comparison["same_origin"]


def test_record_signature_blocks_rewritten_history_but_survives_browser_roundtrip():
    run = service.advance(service.create_run({"ref": "P01_intro"}, "priority", "goal-greedy"), 12)
    forged = json.loads(json.dumps(run))
    forged["events"].append({"id": "INJ", "at_step": 3, "type": "satellite_outage", "satellite_ids": ["S01"], "end_step": 9})
    with pytest.raises(InputError, match="Подпись записи"):
        service.view(forged)
    # Браузер: 125.0 → 125 (JavaScript), другой id — подпись остаётся верной.
    def js(x):
        if isinstance(x, float) and x.is_integer():
            return int(x)
        if isinstance(x, dict):
            return {k: js(v) for k, v in x.items()}
        return [js(v) for v in x] if isinstance(x, list) else x
    browser = js(json.loads(json.dumps(run)))
    browser["id"] = "copy-in-browser"
    assert service.view(browser)["step"] == 12
    unsigned = {k: v for k, v in run.items() if k != "signature"}
    with pytest.raises(InputError, match="Подпись записи"):
        service.advance(unsigned, 13)


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


def test_started_job_disrupted_by_later_message_is_problem_limit():
    """Начатое задание сорвало сообщение, пришедшее после начала: это ограничение задачи с цифрами, а не решение алгоритма."""
    s = load("data/P01_intro.json")
    job = dict(s["jobs"][0], id="DIS-1", kind="downlink", release_step=0, deadline_step=20, work_steps=4,
               eligible_satellites=["S01"], priority=3, value_usd=500.0)
    s["jobs"] = [job]
    s["environment"]["S01"]["downlink_available"][:20] = [True] * 20
    s["satellites"][0]["initial_calibration_age_steps"] = 0
    run = service.advance(service.create_run({"inline": s}, "priority", "goal-greedy"), 2)
    assert [c["step"] for c in run["commands"] if c.get("job_id") == "DIS-1"] == [0, 1]
    run, err = service.apply_event(run, {"id": "OUT", "at_step": 2, "type": "satellite_outage", "satellite_ids": ["S01"], "end_step": 20})
    assert err is None
    run = service.advance(run, 20)
    e = service.explain(run, job_id="DIS-1")
    assert e["loss"]["group"] == "problem_limit" and e["loss"]["code"] == "disrupted_by_event"
    assert "OUT" in e["consequence"]


def test_idle_satellite_gets_concrete_reason():
    """Простой объясняется наблюдением на шаге (нет заданий / нет связи / заняты другими / A10 / …), а не «не доказано»."""
    run = service.advance(service.create_run({"ref": "P02_shift"}, "priority", "goal-greedy"), 20)
    reasons = set()
    for i in range(1, 49):
        e = service.explain(run, satellite_id=f"S{i:02d}", step=11)
        if "idle_reason" in e:
            reasons.add(e["idle_reason"])
            assert "не доказан" not in e["consequence"]
    assert reasons and reasons <= {"idle_energy_reserve", "idle_no_open_job", "idle_no_contact", "idle_taken",
                                   "idle_calibration_required", "idle_thermal_limit", "idle_ground_capacity",
                                   "idle_hopeless_cut", "idle_planner_choice"}


def test_parent_label_not_signed_but_history_is():
    """parent — метка ветви в браузере: при пересчёте её переносят, подпись остаётся верной."""
    run = service.advance(service.create_run({"ref": "P01_intro"}, "priority", "goal-greedy"), 6)
    moved = json.loads(json.dumps(run))
    moved["run_metadata"]["parent"] = {"run_id": "old-parent", "fork_step": 3}
    assert service.view(moved)["step"] == 6
