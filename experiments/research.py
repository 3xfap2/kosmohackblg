"""Проверка допущений и устойчивости: python -m experiments.research → results/research.json.

1. Чувствительность настроек CP-SAT (A1 окно, A2 период перестройки, A3 ценность остатка энергии):
   P02, приоритетный режим, меняется одна настройка, остальные — по умолчанию (48, 6, 0,5).
2. Стресс-тест (F7) с seed 7: 12 случайных допустимых наборов отказов и отмен связи,
   эвристика против простого правила, P02 и P04, приоритетный режим.
Каждый прогон — полная смена официальной моделью.
"""
import json
import time
from pathlib import Path

from core import features, service
from core.planner import make_planner
from model.operations import Session, digest
from model.resource_env import load

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {"horizon": 48, "replan_every": 6, "energy_value_usd_per_wh": 0.5}
GRID = {"horizon": (24, 36, 48, 72), "replan_every": (3, 6, 12), "energy_value_usd_per_wh": (0, 0.25, 0.5, 1)}


def shift(scenario, params):
    planner = make_planner("horizon-cpsat", "priority", **params)
    session = Session(scenario)
    start = time.perf_counter()
    for _ in range(scenario["time"]["steps"]):
        session.advance(planner.decide(session))
    m = session.summary()
    return {"p3_done": m["critical_jobs_completed_on_time"], "p3_due": m["critical_jobs_due"],
            "jobs_done": m["jobs_completed"], "revenue_usd": round(m["revenue_usd"], 2),
            "below_reserve_steps": m["below_reserve_satellite_steps"], "blocked": m["blocked_command_count"],
            "cpsat_selected": sum(not x["fallback"] and not x.get("baseline_guard", False) for x in planner.solves),
            "solves": len(planner.solves), "command_hash": digest(session.commands),
            "seconds": round(time.perf_counter() - start, 1)}


def main():
    out = {"schema_version": 1, "sensitivity": {"scenario": "P02_shift", "goal": "priority", "algorithm": "horizon-cpsat",
                                                "defaults": DEFAULTS, "runs": {}}, "stress": {}}
    scenario = load(ROOT / "data" / "P02_shift.json")
    done = {}
    for name, values in GRID.items():
        for value in values:
            params = {**DEFAULTS, name: value}
            key = f"{name}={value}"
            label = json.dumps(params, sort_keys=True)
            if label not in done:          # точка «по умолчанию» считается один раз
                done[label] = shift(scenario, params)
                print(key, done[label], flush=True)
            out["sensitivity"]["runs"][key] = {**done[label], "parameters": params}
    for ref in ("P02_shift", "P04_demand"):
        record = service.create_run({"ref": ref}, "priority", "goal-greedy")
        r = features.stress_test(record, runs=12, seed=7)
        out["stress"][ref] = {k: r[k] for k in ("seed", "runs", "goal", "wins", "ours", "baseline")} | {
            "rows": [{"run": x["run"], "events": x["events"], "ours": {k: x["ours"][k] for k in ("p3_done", "revenue_usd")},
                      "baseline": {k: x["baseline"][k] for k in ("p3_done", "revenue_usd")}} for x in r["rows"]]}
        print(ref, "stress wins", r["wins"], "of", r["runs"], flush=True)
    path = ROOT / "results" / "research.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("записано:", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
