import copy
import pytest
from model.operations import Session, replay_episode
from model.resource_env import load
from core.planner import make_planner
from core.planner.physics import step_delta


def tiny():
    s = load("data/P01_intro.json")
    sat = copy.deepcopy(s["satellites"][0])
    sat.update(id="S", capacity_wh=100, initial_soc_pct=100, initial_temp_c=20,
               base_w=0, heater_w=0, relay_w=12, initial_calibration_age_steps=0)
    s["satellites"] = [sat]
    s["time"]["steps"] = 3
    s["environment"] = {"S": {"solar_w": [0]*3, "thermal_target_c": [20]*3,
        "relay_available": [True]*3, "downlink_available": [True]*3}}
    s["model"].update(thermal_gain_c_per_w=0, discharge_efficiency=1)
    s["failures"] = []
    s["jobs"] = [dict(id="J", kind="relay", priority=3, value_usd=50,
        release_step=0, deadline_step=2, work_steps=2, eligible_satellites=["S"])]
    return s


@pytest.mark.parametrize("algorithm", ["edf-baseline", "horizon-cpsat"])
def test_hand_calculated_and_replay(algorithm):
    session = Session(tiny())
    planner = make_planner(algorithm)
    for _ in range(3):
        session.advance(planner.decide(session))
    assert session.summary()["revenue_usd"] == 50
    assert session.env.state["S"]["energy_wh"] == 98
    assert session.summary()["blocked_command_count"] == 0
    restored = replay_episode(session.initial_scenario, [], session.commands, 3)
    assert restored.result()["trace"] == session.result()["trace"]
    assert restored.summary() == session.summary()


def test_idle_forecast_is_not_a_lower_energy_bound():
    s = tiny()
    sat, m = s["satellites"][0], s["model"]
    m.update(charge_min_c=0, charge_max_c=25)
    # При одной мощности холодный аппарат заряжается, нагретый — нет.
    cool, _ = step_delta(sat, m, 60, 20, 20, 12)
    hot, _ = step_delta(sat, m, 60, 20, 26, 12)
    assert cool > hot == 0


@pytest.mark.parametrize("params", [{"workers": 8}, {"deterministic_limit": 0},
    {"horizon": True}, {"unknown": 1}, {"energy_value_usd_per_wh": float("nan")}])
def test_invalid_parameters(params):
    with pytest.raises(ValueError):
        make_planner("horizon-cpsat", **params)


def test_repeat_commands():
    outputs = []
    for _ in range(2):
        session, planner = Session(tiny()), make_planner("horizon-cpsat")
        for _ in range(3):
            session.advance(planner.decide(session))
        outputs.append(session.commands)
    assert outputs[0] == outputs[1]


def test_fallback_does_not_solve_every_step(monkeypatch):
    from ortools.sat.python import cp_model
    solve = cp_model.CpSolver.Solve
    def no_solution(self, *args, **kwargs):
        solve(self, *args, **kwargs)
        return cp_model.UNKNOWN
    monkeypatch.setattr(cp_model.CpSolver, "Solve", no_solution)
    session = Session(load("data/P01_intro.json"))
    planner = make_planner("horizon-cpsat", deterministic_limit=1e-12)
    for _ in range(6):
        session.advance(planner.decide(session))
    assert planner.solves[0]["fallback"]
    assert len(planner.solves) == 1
    session.advance(planner.decide(session))
    assert len(planner.solves) == 2


def test_goal_changes_selection():
    s = tiny()
    s["jobs"] = [dict(s["jobs"][0], id="P3", work_steps=1, deadline_step=1, value_usd=1),
                 dict(s["jobs"][0], id="MONEY", priority=1, work_steps=1, deadline_step=1, value_usd=100)]
    for algorithm in ("edf-baseline", "horizon-cpsat"):
        chosen = []
        for goal in ("priority", "revenue"):
            session = Session(s)
            session.advance(make_planner(algorithm, goal).decide(session))
            chosen.append(session.env.completed)
        assert chosen == [["P3"], ["MONEY"]]


def test_guard_score_and_chunked_cache():
    session = Session(tiny())
    planner = make_planner("horizon-cpsat")
    planner.decide(session)
    solve = planner.last_solve
    assert solve["baseline_guard"] == (solve["baseline_score"] >= solve["candidate_score"])
    assert planner._rollout(session, 3, planner.plan)[1] >= solve["baseline_score"]
