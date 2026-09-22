"""Проверка так, как её проводит жюри (постановка, «Проверка решения»):
свой сценарий того же формата, изменённые условия, сообщения по одному, некорректные и
повторные сообщения, расчёт до конца, выгрузка и повтор моделью организаторов."""
import json
from pathlib import Path

import pytest

from core import service
from core.errors import InputError

ROOT = Path(__file__).resolve().parents[1]


def scenario(name):
    return json.loads((ROOT / "data" / f"{name}.json").read_text(encoding="utf-8"))


def test_all_setup_overrides_including_known_unavailability():
    source = {"ref": "P02_shift", "overrides": {
        "solar_factor": 0.5, "initial_soc_pct": {"S01": 40.0}, "job_priority": {"JOB-0001": 1},
        "failures": [{"satellite_id": "S08", "start_step": 60, "end_step": 120}]}}
    info = service.inspect_scenario(source)
    assert info["derived_from"] == "P02_shift" and info["overrides"]["failures"][0]["satellite_id"] == "S08"
    run = service.advance(service.create_run(source, "priority", "goal-greedy"), 150)
    s08 = [c for c in run["commands"] if c["satellite_id"] == "S08" and 60 <= c["step"] < 120]
    assert all(c["action"] == "idle" for c in s08)            # планировщик знает период заранее
    assert service.replay(service.export(run))["match"]
    for bad in ({"satellite_id": "S99", "start_step": 1, "end_step": 5},
                {"satellite_id": "S01", "start_step": 5, "end_step": 999},
                {"satellite_id": "S01", "start_step": 5}):
        with pytest.raises(InputError):
            service.inspect_scenario({"ref": "P02_shift", "overrides": {"failures": [bad]}})


@pytest.mark.parametrize("algorithm", ["goal-greedy", "horizon-cpsat"])
def test_own_scenario_messages_one_by_one(algorithm):
    s = scenario("P01_intro")
    s["meta"]["id"] = "JURY-01"
    s["satellites"][0]["initial_soc_pct"] = 45.0
    job = dict(s["jobs"][0], id="JURY-URG-1", release_step=20, deadline_step=40, priority=3, value_usd=99.0)
    events = [
        {"id": "J-1", "at_step": 10, "type": "satellite_outage", "satellite_ids": ["S01", "S02"], "end_step": 20},
        {"id": "J-2", "at_step": 15, "type": "close_downlink", "satellite_ids": ["S03"], "end_step": 30},
        {"id": "J-3", "at_step": 20, "type": "add_jobs", "jobs": [job]},
    ]
    run = service.create_run({"inline": s}, "priority", algorithm)
    for e in events:
        run = service.advance(run, e["at_step"])
        before = json.dumps(run, sort_keys=True)
        run, err = service.apply_event(run, e)
        assert err is None, err
        # Повторное и битое сообщения отклоняются, состояние расчёта не меняется.
        for bad in (e, {"id": "X", "at_step": e["at_step"], "type": "unknown"}, "не JSON-объект"):
            again, err = service.apply_event(run, bad)
            assert err and again["events"] == run["events"] and again["commands"] == run["commands"]
        assert json.dumps(run, sort_keys=True) != before
    run = service.advance(run, s["time"]["steps"], 600)
    assert run["steps_executed"] == s["time"]["steps"]
    assert [e["id"] for e in run["events"]] == ["J-1", "J-2", "J-3"]
    assert "JURY-URG-1" in {j["id"] for j in service.jobs(run)}     # новое задание в учёте, выполнено оно или нет
    assert service.replay(service.export(run))["match"]


def test_p04_messages_one_by_one_to_end():
    events = [
        {"id": "J-1", "at_step": 60, "type": "satellite_outage", "satellite_ids": ["S01", "S02", "S03", "S04"], "end_step": 120},
        {"id": "J-2", "at_step": 100, "type": "close_downlink", "satellite_ids": [f"S{i:02d}" for i in range(1, 13)], "end_step": 130},
    ]
    run = service.create_run({"ref": "P04_demand"}, "revenue", "goal-greedy")
    for e in events:
        run, err = service.apply_event(service.advance(run, e["at_step"]), e)
        assert err is None, err
    run = service.advance(run, 288, 600)
    view = service.view(run)
    assert view["summary"]["blocked_command_count"] == 0
    assert service.replay(service.export(run))["match"]
