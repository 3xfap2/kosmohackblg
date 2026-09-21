"""Воспроизводимые эксперименты: python -m experiments.run [--repeat]."""
import argparse
from collections import Counter
import json
from pathlib import Path
import time

from core.planner import make_planner
from core.planner.base import Admission
from model.operations import Session, digest, replay_episode
from model.resource_env import load

ROOT = Path(__file__).resolve().parents[1]


def episode(scenario, algorithm, goal, events=(), frozen=None):
    planner = make_planner(algorithm, goal)
    session = Session(scenario, {**planner.metadata(), "goal": goal,
        "goal_history": [{"step": 0, "goal": goal}], "mode": "adaptive" if frozen is None else "frozen"})
    by_step = {}
    for event in events:
        by_step.setdefault(event["at_step"], []).append(event)
    rejection = Counter()
    start = time.perf_counter()
    for step in range(scenario["time"]["steps"]):
        for event in by_step.get(step, []):
            session.apply_event(event)
        if frozen is None:
            actions = planner.decide(session)
            rejection.update(note.split(":", 1)[1] for note in planner.last_notes.values()
                             if note.startswith("plan_rejected:"))
        else:
            admission = Admission(session.env)
            for sid, action in sorted(frozen.get(step, {}).items()):
                ok, reason = admission.add(sid, action)
                if not ok:
                    rejection[reason] += 1
            actions = admission.accepted
        session.advance(actions)
    elapsed = time.perf_counter() - start
    result = session.result()
    restored = replay_episode(scenario, result["events"], result["commands"], session.env.k)
    if restored.summary() != session.summary() or restored.env.trace != session.env.trace:
        raise AssertionError("Воспроизведение расходится с исходным расчётом")
    stats = {"summary": session.summary(), "command_hash": digest(session.commands),
        "plan_rejections": dict(sorted(rejection.items())), "replay_match": True,
        "fallback_solves": sum(x["fallback"] for x in getattr(planner, "solves", [])),
        "baseline_guard_solves": sum(x.get("baseline_guard", False) for x in getattr(planner, "solves", [])),
        "solves": len(getattr(planner, "solves", [])), "parameters": planner.params,
        "algorithm_version": planner.version, "scenario_hash": digest(scenario),
        "events_hash": digest(result["events"])}
    return result, stats, elapsed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", action="store_true")
    parser.add_argument("--scenarios", nargs="+", default=["P01", "P02", "P03", "P04"])
    parser.add_argument("--events", action="store_true")
    args = parser.parse_args()
    output = ROOT / "results"
    (output / "runs").mkdir(parents=True, exist_ok=True)
    path = output / "summary.json"
    summary = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schema_version": 1, "runs": {}}
    timings = {}
    for file in sorted((ROOT / "data").glob("*.json")):
        if not any(file.stem.startswith(x) for x in args.scenarios):
            continue
        scenario = load(file)
        for algorithm in ("edf-baseline", "horizon-cpsat"):
            for goal in ("priority", "revenue"):
                key = f"{file.stem}__{algorithm}__{goal}"
                result, stats, elapsed = episode(scenario, algorithm, goal)
                if args.repeat:
                    other, _, second = episode(scenario, algorithm, goal)
                    assert digest(result) == digest(other), key + ": повтор не совпал"
                    stats["repeat_match"] = True
                    timings[key + "__repeat"] = round(second, 3)
                stats.update(scenario_id=scenario["meta"]["id"], goal=goal, algorithm=algorithm)
                (output / "runs" / (key + ".json")).write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                summary["runs"][key] = stats
                path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
                timings[key] = round(elapsed, 3)
                print(key, stats["summary"]["jobs_completed"], stats["summary"]["revenue_usd"],
                      f"{elapsed:.2f}s", "fallback", stats["fallback_solves"], flush=True)
    if args.events:
        scenario = load(ROOT / "data/P02_shift.json")
        events = json.loads((ROOT / "examples/events_demo.json").read_text(encoding="utf-8"))["events"]
        for goal in ("priority", "revenue"):
            base_key = f"P02_shift__horizon-cpsat__{goal}"
            baseline = json.loads((output / "runs" / (base_key + ".json")).read_text(encoding="utf-8"))
            frozen = {}
            for c in baseline["commands"]:
                frozen.setdefault(c["step"], {})[c["satellite_id"]] = {k: v for k, v in c.items() if k not in ("step", "satellite_id")}
            for mode in ("adaptive", "frozen"):
                key = f"P02_events__{mode}__{goal}"
                result, stats, elapsed = episode(scenario, "horizon-cpsat", goal, events,
                                                frozen if mode == "frozen" else None)
                if args.repeat:
                    other, _, _ = episode(scenario, "horizon-cpsat", goal, events,
                                           frozen if mode == "frozen" else None)
                    assert digest(result) == digest(other)
                    stats["repeat_match"] = True
                stats.update(scenario_id=scenario["meta"]["id"], goal=goal, algorithm="horizon-cpsat", mode=mode)
                summary["runs"][key] = stats
                (output / "runs" / (key + ".json")).write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                timings[key] = round(elapsed, 3)
                print(key, stats["summary"], flush=True)
        path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    # Время машины не входит в детерминированную сводку и сохраняется отдельно.
    timing_path = output / "timings.json"
    previous = json.loads(timing_path.read_text()) if timing_path.exists() else {}
    previous.update(timings)
    timing_path.write_text(json.dumps(previous, indent=2, sort_keys=True), encoding="utf-8")


if __name__ == "__main__":
    main()
