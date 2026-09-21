"""Расширенная модель (core/extended.py): совместимость с официальной и новые явления."""
from pathlib import Path

import pytest

from core.extended import NEUTRAL, EXT_DEFAULTS, ExtendedSession, replay_extended
from core.planner import make_planner
from model.operations import Session, digest
from model.resource_env import load

ROOT = Path(__file__).resolve().parents[1]


def run(session, planner, steps):
    for _ in range(steps):
        session.advance(planner.decide(session))
    return session


def test_neutral_extension_equals_official_model():
    s = load(ROOT / "data" / "P02_shift.json")
    ext = run(ExtendedSession(s, params=NEUTRAL), make_planner("goal-greedy"), 96)
    off = run(Session(s), make_planner("goal-greedy"), 96)
    assert digest(ext.commands) == digest(off.commands)
    keys = ("energy_after_wh", "temp_after_c", "executed", "reason")
    assert [[r[k] for k in keys] for r in ext.env.trace] == [[r[k] for k in keys] for r in off.env.trace]


def test_pointing_in_light_and_slew_cost_energy():
    s = load(ROOT / "data" / "P02_shift.json")
    sid = "S01"
    lit = next(t for t, w in enumerate(s["environment"][sid]["solar_w"]) if w > 0)
    base = ExtendedSession(s, params={**EXT_DEFAULTS, "pointing_solar_factor": 1.0, "slew_wh": 0.0})
    ext = ExtendedSession(s, params=EXT_DEFAULTS)
    for sess in (base, ext):
        for _ in range(lit):
            sess.advance({})
        sess.advance({sid: {"action": "calibrate"}})
    rb, re_ = base.env.trace[-48:], ext.env.trace[-48:]
    rb, re_ = next(r for r in rb if r["satellite_id"] == sid), next(r for r in re_ if r["satellite_id"] == sid)
    assert re_["slew"] and re_["attitude"] == "star" and re_["solar_lost_w"] > 0
    assert re_["energy_after_wh"] < rb["energy_after_wh"]


def test_link_needs_contact_and_shares_ground_limit():
    s = load(ROOT / "data" / "P02_shift.json")
    sess = ExtendedSession(s, params=EXT_DEFAULTS)
    env = sess.env
    no_contact = next(sid for sid in env.sats if not s["environment"][sid]["downlink_available"][0])
    assert env.can_execute(no_contact, {"action": "link"})[1] == "no_contact"
    contact = [sid for sid in sorted(env.sats) if s["environment"][sid]["downlink_available"][0]]
    limit = s["model"]["downlink_parallel_limit"]
    if len(contact) > limit:
        rows = sess.advance({sid: {"action": "link"} for sid in contact[:limit + 1]})
        reasons = [r["reason"] for r in rows if r["satellite_id"] in contact[:limit + 1]]
        assert reasons.count("ground_capacity") == 1


def test_link_guard_raises_link_coverage_and_replays():
    s = load(ROOT / "data" / "P02_shift.json")
    plain = run(ExtendedSession(s), make_planner("goal-greedy"), 96)
    guard = run(ExtendedSession(s), make_planner("goal-greedy", link_guard=True), 96)
    assert guard.summary()["ext_link_coverage"] > plain.summary()["ext_link_coverage"]
    assert guard.summary()["blocked_command_count"] == 0
    again = replay_extended(s, [], guard.commands)
    assert again.summary() == guard.summary()


def test_extended_flags_are_validated_and_hidden_when_off():
    with pytest.raises(ValueError):
        make_planner("goal-greedy", link_guard="yes")
    with pytest.raises(ValueError):
        ExtendedSession(load(ROOT / "data" / "P01_intro.json"), params={"pointing_solar_factor": 2})
    assert "link_guard" not in make_planner("goal-greedy").metadata()["parameters"]
