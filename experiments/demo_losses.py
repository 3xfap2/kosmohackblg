"""Проверяемая таблица потерь демо-смены: python -m experiments.demo_losses.

Демо-смена — как /api/demo: P02, эвристика по цели, приоритетный режим, сообщения
организаторов до 12:00 (шаг 144). Для каждого потерянного задания P3 выписываются
окно, требуемая работа, шаги с контактом у допустимых исполнителей (с учётом отказов),
сами исполнители и вывод ядра (core/analysis.py). Результат: results/demo_losses.json.
"""
import json
from pathlib import Path

from core import service
from core.availability import unavailable
from core.service import restore as _restore

ROOT = Path(__file__).resolve().parents[1]
STOP = 144


def demo_run():
    events = json.loads((ROOT / "examples" / "events_demo.json").read_text(encoding="utf-8"))["events"]
    run = service.create_run({"ref": "P02_shift"}, "priority", "goal-greedy")
    for e in [e for e in events if e["at_step"] < STOP]:
        run, err = service.apply_event(service.advance(run, e["at_step"]), e)
        assert err is None, err
    return service.advance(run, STOP)


def main():
    run = demo_run()
    session, _ = _restore(run)
    env = session.env
    views = {j["id"]: j for j in service.jobs(run, "missed", 3)}
    rows = []
    for jid, v in sorted(views.items()):
        job = env.jobs[jid]
        kind = job["kind"] + "_available"
        window = range(job["release_step"], job["deadline_step"])
        out = [f for f in env.s["failures"] if f["satellite_id"] in job["eligible_satellites"]]
        def usable(sid, t):
            return env.s["environment"][sid][kind][t] and not unavailable(env.s, sid, t)
        contact = [t for t in window if any(usable(sid, t) for sid in job["eligible_satellites"])]
        e = service.explain(run, job_id=jid)
        rows.append({"job_id": jid, "kind": job["kind"], "priority": job["priority"],
                     "window_steps": [job["release_step"], job["deadline_step"]], "work_steps": job["work_steps"],
                     "done_steps": job["work_steps"] - job["remaining_steps"],
                     "eligible_satellites": job["eligible_satellites"],
                     "contact_steps_in_window": len(contact), "outages_of_eligible": out,
                     "group": (e.get("loss") or {}).get("group"), "code": (e.get("loss") or {}).get("code"),
                     "evidence": e.get("consequence")})
    result = {"run": "P02 + сообщения до шага 144, goal-greedy, priority", "step": STOP,
              "missed_p3": len(rows), "problem_limit": sum(r["group"] == "problem_limit" for r in rows),
              "planner_choice": sum(r["group"] == "planner_choice" for r in rows),
              "not_established": sum(r["group"] is None for r in rows), "jobs": rows}
    (ROOT / "results" / "demo_losses.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"потеряно P3: {result['missed_p3']} · ограничение задачи: {result['problem_limit']} · "
          f"решение алгоритма: {result['planner_choice']} · не установлено: {result['not_established']}")
    for r in rows:
        print(f"{r['job_id']:9} окно {r['window_steps']} работа {r['work_steps']} контактов {r['contact_steps_in_window']:2} "
              f"исполнители {','.join(r['eligible_satellites'])} → {r['group']}: {r['code']}")


if __name__ == "__main__":
    main()
