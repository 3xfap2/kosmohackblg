"""Функции О7: каждая считает через официальную модель и не меняет запись запуска."""
import copy

import pytest
from core import features as F, service
from core.errors import InputError


@pytest.fixture(scope="module")
def run():
    r = service.create_run({"ref": "P01_intro"}, "priority", "goal-greedy")
    return service.advance(r, 24)


def test_impact_three_branches_from_same_state(run):
    before = copy.deepcopy(run)
    ev = {"id": "T-1", "at_step": 24, "type": "satellite_outage", "satellite_ids": ["S01", "S02"], "end_step": 40}
    r = F.event_impact(run, ev, horizon=24)
    assert run == before
    assert r["from_step"] == 24 and r["until_step"] == 48
    assert set(r) >= {"without_event", "replanned", "old_plan", "saved_by_replanning", "cost_of_event"}
    with pytest.raises(InputError):
        F.event_impact(run, {"id": "T-2", "at_step": 3, "type": "satellite_outage", "satellite_ids": ["S01"], "end_step": 9})


def test_forecast_does_not_advance_record(run):
    r = F.forecast(run, horizon=12)
    assert r["from_step"] == 24 and r["until_step"] == 36
    assert service.view(run)["step"] == 24


def test_why_not_needs_passed_deadline_and_gives_proof_or_counterfactual():
    full = service.advance(service.create_run({"ref": "P01_intro"}, "priority", "goal-greedy"), 48)
    missed = [j for j in service.jobs(full) if j["status"] == "missed"]
    assert missed
    r = F.why_not(full, missed[0]["id"])
    assert r["verdict"] in ("impossible", "possible", "not_found")
    with pytest.raises(InputError):
        F.why_not(full, "NO-SUCH-JOB")


def test_scenario_experiments_and_passport(run):
    w = F.what_if(run)
    assert w["base"]["jobs_total"] > 0 and len(w["variants"]) == 3
    points = F.frontier(run)["points"]
    assert not all(p["dominated"] for p in points)
    st = F.stress_test(run, runs=2, seed=1)
    assert st == F.stress_test(run, runs=2, seed=1)          # воспроизводимо при том же seed
    link = F.link_continuity(run)
    assert 0 <= link["contact_share"] <= 1
    p = F.passport(run, "S01")
    assert p["steps"] == 24 and p["calibration_due_step"] >= 24
    assert F.shift_report(run)["markdown"].startswith("# Передача смены")
