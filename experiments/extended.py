"""Эксперименты расширенной модели (ориентация, светотень, связь): python -m experiments.extended.

Одинаковые сценарии и цели; меняется только планировщик. Каждый прогон:
исполнен расширенной моделью (core/extended.py), повторён из журнала команд
(replay_extended) и рассчитан дважды. Отдельно проверяется совместимость:
с нейтральными параметрами расширение даёт те же команды и итог, что официальная модель.
Результат: results/extended_summary.json.
"""
import json
from pathlib import Path

from core.extended import NEUTRAL, EXT_DEFAULTS, ExtendedSession, replay_extended
from core.planner import make_planner
from model.operations import Session, digest
from model.resource_env import load

ROOT = Path(__file__).resolve().parents[1]
VARIANTS = {
    "edf-baseline": ("edf-baseline", {}),
    "goal-greedy": ("goal-greedy", {}),
    "goal-greedy+attitude": ("goal-greedy", {"attitude_aware": True}),
    "goal-greedy+attitude+link": ("goal-greedy", {"attitude_aware": True, "link_guard": True}),
}


def run(scenario, algorithm, goal, planner_params, ext_params, official=False):
    planner = make_planner(algorithm, goal, **planner_params)
    session = Session(scenario) if official else ExtendedSession(scenario, params=ext_params)
    for _ in range(scenario["time"]["steps"]):
        session.advance(planner.decide(session))
    return session


def row(session):
    s = session.summary()
    keep = ("critical_jobs_completed_on_time", "critical_jobs_due", "jobs_completed", "jobs_total", "revenue_usd",
            "blocked_command_count", "below_reserve_satellite_steps", "minimum_soc_pct", "work_steps_in_missed_jobs",
            "ext_slews", "ext_solar_lost_wh", "ext_link_steps", "ext_link_coverage", "ext_longest_link_gap_steps")
    out = {k: s[k] for k in keep}
    out["mean_terminal_soc_pct"] = round(sum(s["terminal_soc_pct"].values()) / len(s["terminal_soc_pct"]), 6)
    return out


def main():
    out = {"schema_version": 1, "model": "extended", "parameters": EXT_DEFAULTS, "runs": {}, "compat": {}, "sensitivity": {}}
    for stem in ("P02_shift", "P03_energy", "P04_demand"):
        scenario = load(ROOT / "data" / f"{stem}.json")
        # Совместимость: нейтральное расширение == официальная модель (команды и итог эвристики).
        a = run(scenario, "goal-greedy", "priority", {}, NEUTRAL)
        b = run(scenario, "goal-greedy", "priority", {}, None, official=True)
        off = b.summary()
        same = digest(a.commands) == digest(b.commands) and all(a.summary()[k] == off[k] for k in off)
        out["compat"][stem] = same
        assert same, stem + ": нейтральное расширение разошлось с официальной моделью"
        for goal in ("priority", "revenue"):
            for name, (algorithm, params) in VARIANTS.items():
                key = f"{stem}__{name}__{goal}"
                first = run(scenario, algorithm, goal, params, EXT_DEFAULTS)
                second = run(scenario, algorithm, goal, params, EXT_DEFAULTS)
                replayed = replay_extended(scenario, [], first.commands, EXT_DEFAULTS)
                r = row(first)
                r.update(repeat_match=digest(first.commands) == digest(second.commands),
                         replay_match=replayed.summary() == first.summary() and replayed.env.trace == first.env.trace,
                         command_hash=digest(first.commands))
                out["runs"][key] = r
                print(key, r["critical_jobs_completed_on_time"], r["revenue_usd"], r["below_reserve_satellite_steps"],
                      r["ext_link_coverage"], r["repeat_match"], r["replay_match"], flush=True)
    # Чувствительность к главному допущению — доле генерации при отвёрнутых панелях.
    scenario = load(ROOT / "data" / "P03_energy.json")
    for factor in (0.4, 0.6, 0.8, 1.0):
        params = {**EXT_DEFAULTS, "pointing_solar_factor": factor}
        for name in ("goal-greedy", "goal-greedy+attitude"):
            algorithm, p = VARIANTS[name]
            out["sensitivity"][f"P03_energy__{name}__priority__f{factor}"] = row(run(scenario, algorithm, "priority", p, params))
    path = ROOT / "results" / "extended_summary.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("записано:", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
