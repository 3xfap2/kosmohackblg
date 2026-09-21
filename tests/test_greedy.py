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
