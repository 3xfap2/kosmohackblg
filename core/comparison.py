"""Сравнение продолжений с явной проверкой происхождения и условий."""
from model.operations import digest, replay_episode


def compare_records(ra, rb, a, b, va, vb):
    same_scenario = digest(a.initial_scenario) == digest(b.initial_scenario)
    parents = [r["run_metadata"].get("parent") for r in (ra, rb)]
    boundaries = [p["fork_step"] for p in parents if p]
    candidate = min(boundaries) if boundaries else 0
    candidate = min(candidate, a.env.k, b.env.k)
    def prefix(session):
        # Граница до получения новых сообщений этого шага: оба продолжения имеют один прошлый префикс.
        return replay_episode(session.initial_scenario,
            [e for e in session.events if e["at_step"] < candidate],
            [c for c in session.commands if c["step"] < candidate], candidate)
    sa, sb = prefix(a), prefix(b)
    origin = same_scenario and sa.state_digest() == sb.state_digest() and digest(sa.env.s) == digest(sb.env.s)
    fork_step = candidate if origin else None
    events_equal = ([e for e in a.events if e["at_step"] >= candidate] ==
                    [e for e in b.events if e["at_step"] >= candidate])
    equal_horizon = va["step"] == vb["step"]
    metrics = []
    for side in (va, vb):   # остаток ресурсов в конце: средний и минимальный заряд аппаратов
        soc = side["summary"].get("terminal_soc_pct") or {}
        side["summary"]["mean_terminal_soc_pct"] = round(sum(soc.values()) / len(soc), 6) if soc else None
        side["summary"]["min_terminal_soc_pct"] = round(min(soc.values()), 6) if soc else None
    for name, maximize in (("critical_jobs_completed_on_time", True), ("revenue_usd", True),
                           ("jobs_completed", True), ("jobs_due_missed", False), ("minimum_soc_pct", True),
                           ("mean_terminal_soc_pct", True), ("min_terminal_soc_pct", True),
                           ("below_reserve_satellite_steps", False), ("work_steps_in_missed_jobs", False)):
        x, y = va["summary"][name], vb["summary"][name]
        delta = None if x is None or y is None else y - x
        metrics.append({"name": name, "a": x, "b": y, "delta": delta,
            "better": "equal" if delta is None or abs(delta) <= 1e-6 else "b" if (delta > 0) == maximize else "a"})

    def winner(goal):
        names = ["critical_jobs_completed_on_time", "revenue_usd"] if goal == "priority" else ["revenue_usd"]
        for name in names:
            item = next(m for m in metrics if m["name"] == name)
            if item["better"] != "equal":
                return item["better"]
        return "comparable"

    goal = va["goal"]
    if not origin or not events_equal or not equal_horizon:
        # Разные условия — победителя нет и равенства тоже нет: это отдельный статус, не «сопоставимы».
        preferred, by_goal = "incomparable", {"priority": "incomparable", "revenue": "incomparable"}
        differs = [t for t, bad in (("исходное состояние", not origin), ("сообщения после развилки", not events_equal),
                                    ("конечный шаг", not equal_horizon)) if bad]
        reason = f"Несопоставимо: различаются {', '.join(differs)}. Победитель не определяется."
    else:
        by_goal = {g: winner(g) for g in ("priority", "revenue")}
        preferred = by_goal[goal]
        label = {"priority": "«Приоритетное обслуживание»", "revenue": "«Коммерческая отдача»"}.get(goal, goal)
        reason = (f"Одинаковые исходные условия и события; главная оценка — по цели ветви A: {label}. "
                  "Число P3 сравнивается точно, денежные показатели — с допуском 0.000001 $.")
        if preferred == "comparable":
            reason += " Целевые показатели равны в пределах допуска; это не означает равенства расписаний."
    return {"a": ra["id"], "b": rb["id"], "same_origin": origin, "fork_step": fork_step,
        "same_events_after_fork": events_equal, "metrics": metrics,
        "verdict": {"goal": goal, "preferred": preferred, "by_goal": by_goal, "reason": reason}}
