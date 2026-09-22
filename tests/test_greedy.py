import json

import pytest
from core import service
from core.planner import make_planner
from test_planner import tiny


def test_greedy_rejects_bad_parameters():
    with pytest.raises(ValueError):
        make_planner("goal-greedy", "priority", early_calibration=-1)
    with pytest.raises(ValueError):
        make_planner("goal-greedy", "priority", horizon=48)


def test_greedy_chunked_equals_continuous_and_replays():
    start = service.create_run({"inline": tiny()}, "priority", "goal-greedy")
    whole = service.advance(start, 3)
    chunk = start
    for step in (1, 2, 3):
        chunk = service.advance(json.loads(json.dumps(chunk)), step)
    assert chunk == whole
    assert service.replay(service.export(whole))["match"]


def test_p02_priority_losses_are_all_provable():
    """Ключевое утверждение защиты: на P02 эвристика теряет только доказуемо невыполнимые задания P3."""
    run = service.advance(service.create_run({"ref": "P02_shift"}, "priority", "goal-greedy"), 288, 600)
    missed_p3 = [j for j in service.jobs(run) if j["status"] == "missed" and j["priority"] == 3]
    assert missed_p3, "в P02 есть доказуемо невыполнимые задания P3"
    assert all(j.get("loss", {}).get("group") == "problem_limit" for j in missed_p3)
    assert service.view(run)["summary"]["blocked_command_count"] == 0


@pytest.mark.parametrize("ref", ["P02_shift", "P03_energy", "P04_demand"])
def test_revenue_goal_earns_at_least_priority_goal(ref):
    """Цель «Коммерческая отдача» не должна приносить меньше выручки, чем «Приоритетное обслуживание»."""
    revenue = {}
    for goal in ("priority", "revenue"):
        run = service.advance(service.create_run({"ref": ref}, goal, "goal-greedy"), 288, 600)
        revenue[goal] = service.view(run)["summary"]["revenue_usd"]
    assert revenue["revenue"] >= revenue["priority"], revenue


def test_hopeless_cut_counts_known_unavailability():
    """A10 учитывает известную недоступность: задание, которое из-за отказа не закончить, не начинается."""
    s = json.loads((__import__("pathlib").Path(__file__).resolve().parents[1] / "data" / "P01_intro.json").read_text(encoding="utf-8"))
    job = dict(s["jobs"][0], id="CUT-1", kind="downlink", release_step=0, deadline_step=6, work_steps=3,
               eligible_satellites=["S01"], priority=3, value_usd=1000.0)
    s["jobs"] = [job]
    s["environment"]["S01"]["downlink_available"][:6] = [True] * 6
    s["failures"] = [{"satellite_id": "S01", "start_step": 2, "end_step": 6}]
    run = service.advance(service.create_run({"inline": s}, "priority", "goal-greedy"), 6)
    assert not [c for c in run["commands"] if c.get("job_id") == "CUT-1"]
