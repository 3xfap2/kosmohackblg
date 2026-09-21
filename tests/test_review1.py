"""Регрессии замечаний О3/О5 из ревью № 1."""
import copy

import pytest
from core import service
from core.errors import InputError
from core.planner import make_planner
from model.operations import Session
from test_planner import tiny


def test_rejected_event_russian_and_atomic():
    start = service.create_run({"inline": tiny()}, "priority", "goal-greedy")
    event = {"id": "E", "at_step": 0, "type": "satellite_outage",
             "satellite_ids": ["S"], "end_step": 2}
    accepted, error = service.apply_event(start, event)
    assert error is None
    rejected, error = service.apply_event(accepted, event)
    assert "ещё не использовался" in error
    assert service.export(rejected) == service.export(accepted)
    invalid = {**tiny()["jobs"][0], "id": "NEW", "eligible_satellites": ["missing"]}
    rejected, error = service.apply_event(start, {
        "id": "ADD", "at_step": 0, "type": "add_jobs", "jobs": [invalid]})
    assert "допустимых исполнителей" in error
    assert service.export(rejected) == service.export(start)


def test_scenario_and_replay_errors_russian():
    s = tiny()
    s["jobs"][0]["work_steps"] = "2"
    with pytest.raises(InputError, match="work_steps: требуется целое число"):
        service.create_run({"inline": s}, "priority", "goal-greedy")
    record = service.create_run({"inline": tiny()}, "priority", "goal-greedy")
    result = service.export(record)
    result["steps_executed"] = -1
    with pytest.raises(InputError, match="Некорректный шаг остановки"):
        service.replay(result)


def test_satellite_outage_explains_only_known_event():
    start = service.create_run({"inline": tiny()}, "priority", "goal-greedy")
    start, _ = service.apply_event(start, {
        "id": "E-02", "at_step": 0, "type": "satellite_outage",
        "satellite_ids": ["S"], "end_step": 2})
    run = service.advance(start, 3)
    out = service.explain(run, satellite_id="S", step=1)
    assert out["loss"]["group"] == "problem_limit"
    assert "E-02" in out["consequence"] and "00:10" in out["consequence"]
    assert out["constraint"] == "satellite_unavailable"
    after = service.explain(run, satellite_id="S", step=2)
    assert after["constraint"] != "satellite_unavailable"
    assert "{'action'" not in after["consequence"] and "idle" not in after["consequence"]


def test_horizon_forecast_follows_hint_actions(monkeypatch):
    from core.planner import horizon
    observed = []
    original = horizon.forecast

    def capture(s, sid, k0, k1, temp, kinds=None):
        observed.append(copy.deepcopy(kinds))
        return original(s, sid, k0, k1, temp, kinds)

    monkeypatch.setattr(horizon, "forecast", capture)
    planner = make_planner("horizon-cpsat")
    planner.decide(Session(tiny()))
    assert observed == [{0: "relay", 1: "relay", 2: "idle"}]
    assert planner.params["deterministic_limit"] == 0.5
