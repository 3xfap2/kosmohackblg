"""Функции сверх обязательной части (О7, усиление О2/О3/О4). docs/PROPOSAL_O7.md, F1–F10.

Общие правила:
  * любое число получено прогоном официальной model.operations.Session — физика не пересчитывается;
  * ветви и прогнозы начинаются из фактического состояния записи и не видят будущих сообщений;
  * прогноз — это прогон текущего планировщика вперёд, он помечается как прогноз, а не факт;
  * всё, что меняет условия организатора (лимит каналов, ёмкость батарей), — отдельный эксперимент
    с явной пометкой.
"""
from __future__ import annotations

import copy
import random
import statistics

from model.operations import Session
from .analysis import impossibility, job_views
from .errors import InputError
from .messages import model_error
from .planner import make_planner
from .planner.base import Admission
from .service import _restore, _source

HEURISTIC = "goal-greedy"


# ---------------------------------------------------------------- общие части
def _clone(session):
    """Копия состояния без истории — для ветвей «что будет дальше»."""
    return copy.deepcopy(session, {id(session.env.trace): [], id(session.commands): []})


def _run(session, planner, until, forced=None):
    while session.env.k < until:
        actions = forced(session) if forced else planner.decide(session)
        session.advance(actions)


def _score(session, start, until):
    """Итог по заданиям со сроком в (start, until] и заряду на выполненных шагах."""
    jobs = [j for j in session.env.jobs.values() if start < j["deadline_step"] <= until]
    done = [j for j in jobs if j["completed_step"] is not None]
    reserve = session.env.s["model"]["reserve_soc_pct"]
    rows = [r for r in session.env.trace if start <= r["step"] < until]
    caps = {sid: v["capacity_wh"] for sid, v in session.env.sats.items()}
    return {
        "p3_due": sum(j["priority"] == 3 for j in jobs),
        "p3_done": sum(j["priority"] == 3 for j in done),
        "jobs_due": len(jobs), "jobs_done": len(done),
        "revenue_usd": round(sum(j["value_usd"] for j in done), 2),
        "below_reserve_steps": sum(100 * r["energy_after_wh"] / caps[r["satellite_id"]] < reserve - 1e-9 for r in rows),
        "blocked_commands": sum(r["reason"] not in ("accepted", "idle") for r in rows),
    }


def _done_ids(session, start, until):
    return {j["id"] for j in session.env.jobs.values()
            if start < j["deadline_step"] <= until and j["completed_step"] is not None}


def _brief(job):
    return {"id": job["id"], "priority": job["priority"], "value_usd": job["value_usd"], "kind": job["kind"]}


def _delta(a, b):
    return {k: round(b[k] - a[k], 2) for k in ("p3_done", "jobs_done", "revenue_usd", "below_reserve_steps")}


def _plan_diff(before, after, start, until):
    """Что изменилось в плане: исполненные действия двух ветвей по шагам [start, until)."""
    def label(r):
        return r["requested"]["job_id"] if r["executed"] == "job" else r["executed"]
    old = {(r["step"], r["satellite_id"]): label(r) for r in before.env.trace if start <= r["step"] < until}
    new = {(r["step"], r["satellite_id"]): label(r) for r in after.env.trace if start <= r["step"] < until}
    changed = sorted(key for key in old if old[key] != new.get(key))
    first = {}
    for step, sid in changed:
        first.setdefault(sid, {"satellite_id": sid, "step": step, "before": old[(step, sid)], "after": new[(step, sid)]})
    moved = {}   # задание сменило исполнителя
    for plan in (old, new):
        for (step, sid), what in plan.items():
            if what not in ("idle", "calibrate"):
                moved.setdefault(what, [set(), set()])[plan is new].add(sid)
    reassigned = sorted(j for j, (a, b) in moved.items() if a and b and a != b)
    return {"satellites_changed": len(first), "assignments_changed": len(changed),
            "reassigned_jobs": reassigned[:20], "reassigned_count": len(reassigned),
            "first_changes": sorted(first.values(), key=lambda x: (x["step"], x["satellite_id"]))[:12]}


# ---------------------------------------------------------------- F1 + F3. Цена события и триаж заявки
def event_impact(record, event, horizon=48):
    """Три продолжения из текущего состояния до одного шага:
    «без события», «событие + перестройка плана», «событие, план не меняли».
    «План не меняли» — исполнение команд ветви «без события»; то, что модель не допустит,
    становится ожиданием с причиной отказа. Сравнение — по заданиям со сроком до конца окна.
    """
    session, planner = _restore(record)
    k, n = session.env.k, session.env.s["time"]["steps"]
    if not isinstance(event, dict):
        raise InputError("Сообщение должно быть объектом JSON")
    until = min(n, k + horizon)
    if event.get("type") == "add_jobs" and isinstance(event.get("jobs"), list):
        deadlines = [j.get("deadline_step") for j in event["jobs"] if isinstance(j, dict) and type(j.get("deadline_step")) is int]
        if deadlines:
            until = min(n, max(until, max(deadlines)))

    base = _clone(session)
    base_planner = copy.deepcopy(planner)
    _run(base, base_planner, until)
    old_plan = {}
    for c in base.commands:
        old_plan.setdefault(c["step"], {})[c["satellite_id"]] = {kk: v for kk, v in c.items() if kk not in ("step", "satellite_id")}

    replanned = _clone(session)
    try:
        replanned.apply_event(copy.deepcopy(event))
    except (ValueError, KeyError, TypeError) as exc:
        raise InputError(f"Сообщение не будет принято моделью: {model_error(exc)}") from exc
    frozen = _clone(replanned)
    _run(replanned, copy.deepcopy(planner), until)
    _run(frozen, None, until, forced=lambda s: old_plan.get(s.env.k, {}))

    a, b, c = (_score(x, k, until) for x in (base, replanned, frozen))
    new_ids = {j["id"] for j in event.get("jobs", [])} if event.get("type") == "add_jobs" else set()
    base_done, re_done, fr_done = (_done_ids(x, k, until) for x in (base, replanned, frozen))
    jobs = replanned.env.jobs
    return {
        "from_step": k, "until_step": until, "algorithm": planner.name, "event_id": event.get("id"),
        "without_event": a, "replanned": b, "old_plan": c,
        "cost_of_event": _delta(a, b),          # во что обошлось событие при перестройке
        "saved_by_replanning": _delta(c, b),    # что спасла перестройка по сравнению со старым планом
        "new_jobs": [dict(_brief(jobs[i]), done=i in re_done) for i in sorted(new_ids)],
        "displaced": [_brief(jobs[i]) for i in sorted(base_done - re_done) if i not in new_ids],
        "saved_jobs": [_brief(jobs[i]) for i in sorted(re_done - fr_done)],
        # F11: что изменилось в плане после сообщения — ветвь «без события» против перестроенной.
        "plan_changes": _plan_diff(base, replanned, k, until),
        "note": "Все три ветви исполнены моделью организаторов из одного состояния; будущие сообщения неизвестны.",
    }


# ---------------------------------------------------------------- F4. Прогноз дефицита
def forecast(record, horizon=24):
    """Прогон текущего планировщика вперёд: кто уйдёт ниже резерва, какие задания P3 не успевают."""
    session, planner = _restore(record)
    k, n = session.env.k, session.env.s["time"]["steps"]
    until = min(n, k + horizon)
    ahead = _clone(session)
    _run(ahead, copy.deepcopy(planner), until)
    reserve = ahead.env.s["model"]["reserve_soc_pct"]
    critical = ahead.env.s["model"]["critical_soc_pct"]
    caps = {sid: v["capacity_wh"] for sid, v in ahead.env.sats.items()}
    alerts = []
    by_sat = {}
    for r in ahead.env.trace:
        soc = 100 * r["energy_after_wh"] / caps[r["satellite_id"]]
        item = by_sat.setdefault(r["satellite_id"], {"min_soc": 101.0, "first_low": None})
        if soc < item["min_soc"]:
            item["min_soc"], item["min_step"] = soc, r["step"]
        if soc < reserve and item["first_low"] is None:
            item["first_low"] = r["step"]
    for sid, item in sorted(by_sat.items()):
        if item["first_low"] is not None:
            alerts.append({"kind": "energy", "severity": "high" if item["min_soc"] < critical else "medium",
                           "step": item["first_low"], "satellite_id": sid, "min_soc_pct": round(item["min_soc"], 1),
                           "text": f"{sid} уйдёт ниже резерва {reserve:.0f}% (минимум {item['min_soc']:.1f}%)"})
    for j in ahead.env.jobs.values():
        if j["priority"] == 3 and k < j["deadline_step"] <= until and j["completed_step"] is None:
            proof = impossibility(ahead.env.s, j)
            alerts.append({"kind": "p3", "severity": "high", "step": j["deadline_step"], "job_id": j["id"],
                           "text": f"{j['id']} (P3) не успевает к {j['deadline_step']}" + (" — невыполнимо по контактам" if proof else "")})
    valid = ahead.env.s["model"]["calibration_valid_steps"]
    for sid, st in session.env.state.items():
        due = k + max(0, valid - st["calibration_age_steps"])
        if due <= until:
            alerts.append({"kind": "calibration", "severity": "low", "step": due, "satellite_id": sid,
                           "text": f"{sid}: срок калибровки истекает на шаге {due}"})
    alerts.sort(key=lambda a: ({"high": 0, "medium": 1, "low": 2}[a["severity"]], a["step"]))
    return {"from_step": k, "until_step": until, "algorithm": planner.name, "alerts": alerts,
            "summary": _score(ahead, k, until),
            "note": "Прогноз: прогон текущего планировщика по известным условиям; новые сообщения его изменят."}


# ---------------------------------------------------------------- F2. «Почему не?» с проверкой
def why_not(record, job_id):
    """Контрфакт: задание назначается принудительно с его открытия, остальное — тем же алгоритмом.
    Показывает, выполнилось бы оно и какие задания пришлось бы отдать. Это проверяемый пример,
    а не поиск минимального изменения."""
    session, planner = _restore(record)
    job = session.env.jobs.get(job_id)
    if job is None:
        raise InputError("Задание не найдено")
    proof = impossibility(session.env.s, job)
    if proof:
        return {"job_id": job_id, "verdict": "impossible", "proof": proof}
    if job["deadline_step"] > session.env.k:
        raise InputError("Срок задания ещё не наступил — оценка доступна после срока")
    if job["completed_step"] is not None:
        return {"job_id": job_id, "verdict": "completed", "completed_step": job["completed_step"]}

    s = _source(record["scenario"])
    start, until = job["release_step"], job["deadline_step"]
    events = [e for e in record["events"] if e["at_step"] <= start]
    later = [e for e in record["events"] if start < e["at_step"] < until]
    from model.operations import replay_episode
    cf = replay_episode(s, events, [c for c in record["commands"] if c["step"] < start], start)
    actual = replay_episode(s, [e for e in record["events"] if e["at_step"] <= until],
                            [c for c in record["commands"] if c["step"] < until], until)
    alt = make_planner(planner.name, planner.goal, **planner.params)

    def forced(sess):
        for e in later:
            if e["at_step"] == sess.env.k and e["id"] not in {x["id"] for x in sess.events}:
                sess.apply_event(copy.deepcopy(e))
        plan = alt.decide(sess)
        j = sess.env.jobs[job_id]
        if j["completed_step"] is not None:
            return plan
        adm = Admission(sess.env)
        chosen = None
        for sid in j["eligible_satellites"]:
            if adm.check(sid, {"action": "job", "job_id": job_id})[0]:
                adm.add(sid, {"action": "job", "job_id": job_id})
                chosen = sid
                break
        for sid, action in sorted(plan.items()):
            if sid != chosen and not (action["action"] == "job" and action.get("job_id") == job_id):
                adm.add(sid, action)
        return adm.accepted

    _run(cf, None, until, forced=forced)
    done_cf, done_real = _done_ids(cf, start, until), _done_ids(actual, start, until)
    cjob = cf.env.jobs[job_id]
    return {
        "job_id": job_id, "verdict": "possible" if cjob["completed_step"] is not None else "not_found",
        "completed_step": cjob["completed_step"], "window": [start, until],
        "displaced": [_brief(actual.env.jobs[i]) for i in sorted(done_real - done_cf)],
        "gained": [_brief(cf.env.jobs[i]) for i in sorted(done_cf - done_real) if i != job_id],
        "actual": _score(actual, start, until), "counterfactual": _score(cf, start, until),
        "note": "Проверено моделью организаторов: задание назначалось первым при каждом допустимом шаге, "
                "остальные решения — тем же алгоритмом. Это пример цены, а не минимальное изменение.",
    }


# ---------------------------------------------------------------- F5–F7. Сценарные эксперименты
def _full_shift(s, goal, algorithm, events, params=None):
    sess = Session(s)
    planner = make_planner(algorithm, goal, **(params or {}))
    by_step = {}
    for e in events:
        by_step.setdefault(e["at_step"], []).append(e)
    n = s["time"]["steps"]
    while sess.env.k < n:
        for e in by_step.get(sess.env.k, []):
            try:
                sess.apply_event(copy.deepcopy(e))
            except ValueError:
                pass   # событие не подходит изменённому сценарию — пропускается, как отказ модели
        sess.advance(planner.decide(sess))
    m = sess.summary()
    return {"p3_done": m["critical_jobs_completed_on_time"], "p3_due": m["critical_jobs_due"],
            "jobs_done": m["jobs_completed"], "jobs_total": m["jobs_total"], "revenue_usd": round(m["revenue_usd"], 2),
            "below_reserve_steps": m["below_reserve_satellite_steps"], "min_soc_pct": m["minimum_soc_pct"]}


def what_if(record):
    """Что даст дополнительный ресурс: полная смена эвристикой по цели на изменённых условиях
    с теми же сообщениями. Изменения условий организатора — отдельный эксперимент."""
    s = _source(record["scenario"])
    goal, events = record["run_metadata"]["goal"], record["events"]

    def variant(label, change, kind):
        v = copy.deepcopy(s)
        change(v)
        return {"label": label, "kind": kind, **_full_shift(v, goal, HEURISTIC, events)}

    def solar(v):
        for env in v["environment"].values():
            env["solar_w"] = [x * 1.1 for x in env["solar_w"]]

    def channels(v):
        v["model"]["downlink_parallel_limit"] += 1

    def battery(v):
        for sat in v["satellites"]:
            sat["capacity_wh"] *= 1.2

    base = {"label": "Как есть", "kind": "base", **_full_shift(s, goal, HEURISTIC, events)}
    variants = [variant("Солнечная мощность +10%", solar, "assumption"),
                variant("Ещё один канал на Землю", channels, "experiment"),
                variant("Ёмкость батарей +20%", battery, "experiment")]
    for v in variants:
        v["delta"] = {k: round(v[k] - base[k], 2) for k in ("p3_done", "jobs_done", "revenue_usd")}
    key = (lambda v: (v["delta"]["p3_done"], v["delta"]["revenue_usd"])) if goal == "priority" else (lambda v: v["delta"]["revenue_usd"])
    variants.sort(key=key, reverse=True)
    return {"goal": goal, "algorithm": HEURISTIC, "base": base, "variants": variants,
            "note": "Условия организатора не меняются: каждый вариант — отдельный эксперимент на копии сценария."}


def frontier(record):
    """Компромисс «приоритет ↔ выручка»: смена эвристикой с разной надбавкой за задания P3."""
    s = _source(record["scenario"])
    points = []
    for bonus in (0, 10, 25, 50, 100, 1000):
        r = _full_shift(s, "revenue", HEURISTIC, record["events"], {"p3_bonus_usd": bonus})
        points.append({"p3_bonus_usd": bonus, **r})
    for p in points:
        p["dominated"] = any(q["p3_done"] >= p["p3_done"] and q["revenue_usd"] >= p["revenue_usd"]
                             and (q["p3_done"], q["revenue_usd"]) != (p["p3_done"], p["revenue_usd"]) for q in points)
    return {"points": points, "note": "Каждая точка — полная смена моделью организаторов; «доминируется» — есть точка "
                                      "не хуже по обоим показателям и лучше хотя бы по одному."}


def _random_events(s, rng, count):
    sats = [v["id"] for v in s["satellites"]]
    n = s["time"]["steps"]
    events = []
    for i in range(count):
        at = rng.randrange(12, n - 24)
        if rng.random() < 0.55:
            ids = rng.sample(sats, rng.randint(1, 3))
            events.append({"id": f"R-{i}", "at_step": at, "type": "satellite_outage",
                           "satellite_ids": sorted(ids), "end_step": min(n, at + rng.randint(12, 36))})
        else:
            ids = rng.sample(sats, rng.randint(4, min(12, len(sats))))
            events.append({"id": f"R-{i}", "at_step": at, "type": "close_downlink",
                           "satellite_ids": sorted(ids), "end_step": min(n, at + rng.randint(6, 24))})
    return sorted(events, key=lambda e: e["at_step"])


def stress_test(record, runs=12, seed=7):
    """Устойчивость: одинаковые случайные допустимые наборы отказов для эвристики и простого правила."""
    if type(runs) is not int or not 1 <= runs <= 30:
        raise InputError("Число наборов — от 1 до 30")
    s = _source(record["scenario"])
    goal = record["run_metadata"]["goal"]
    rng = random.Random(seed)
    rows = []
    for i in range(runs):
        events = _random_events(s, rng, rng.randint(2, 4))
        ours = _full_shift(s, goal, HEURISTIC, events)
        base = _full_shift(s, goal, "edf-baseline", events)
        rows.append({"run": i, "events": len(events), "ours": ours, "baseline": base})

    def stats(key, who):
        vals = [r[who][key] for r in rows]
        return {"min": min(vals), "median": statistics.median(vals), "max": max(vals)}

    wins = sum((r["ours"]["p3_done"], r["ours"]["revenue_usd"]) > (r["baseline"]["p3_done"], r["baseline"]["revenue_usd"]) for r in rows)
    return {"seed": seed, "runs": runs, "goal": goal, "rows": rows, "wins": wins,
            "ours": {"p3_done": stats("p3_done", "ours"), "revenue_usd": stats("revenue_usd", "ours")},
            "baseline": {"p3_done": stats("p3_done", "baseline"), "revenue_usd": stats("revenue_usd", "baseline")},
            "note": "Наборы: 2–4 отказа аппаратов или отмены сеансов в случайные моменты; seed фиксирован."}


# ---------------------------------------------------------------- F8. Непрерывность связи с Землёй
def link_continuity(record):
    session, _ = _restore(record)
    env, k, n = session.env, session.env.k, session.env.s["time"]["steps"]
    avail = [any(env.s["environment"][sid]["downlink_available"][t] for sid in env.sats) for t in range(n)]
    used = [False] * n
    for r in env.trace:
        if r["executed"] == "job" and env.jobs[r["requested"]["job_id"]]["kind"] == "downlink":
            used[r["step"]] = True
    windows, start = [], None
    for t, a in enumerate(avail + [True]):
        if not a and start is None:
            start = t
        elif a and start is not None:
            windows.append({"start": start, "end": t, "steps": t - start, "future": start >= k})
            start = None
    return {"steps": n, "executed": k,
            "contact_share": round(sum(avail) / n, 4),
            "used_share_executed": round(sum(used[:k]) / k, 4) if k else None,
            "dark_windows": windows, "longest_dark_steps": max((w["steps"] for w in windows), default=0),
            "note": "Доступность — из расписания контактов сценария (с учётом сообщений); использование — из журнала."}


# ---------------------------------------------------------------- F9. Паспорт аппарата
def passport(record, satellite_id):
    session, _ = _restore(record)
    env = session.env
    if satellite_id not in env.sats:
        raise InputError("Неизвестный аппарат")
    cap = env.sats[satellite_id]["capacity_wh"]
    reserve = env.s["model"]["reserve_soc_pct"]
    rows = [r for r in env.trace if r["satellite_id"] == satellite_id]
    socs = [100 * r["energy_after_wh"] / cap for r in rows]
    valid = env.s["model"]["calibration_valid_steps"]
    age = env.state[satellite_id]["calibration_age_steps"]
    return {
        "satellite_id": satellite_id, "capacity_wh": cap, "steps": len(rows),
        "soc_now_pct": round(100 * env.state[satellite_id]["energy_wh"] / cap, 1),
        "soc_min_pct": round(min(socs), 1) if socs else None,
        "soc_depth_pct": round(max(socs) - min(socs), 1) if socs else None,   # глубина разряда: max − min за смену
        "below_reserve_steps": sum(x < reserve - 1e-9 for x in socs),
        "heater_steps": sum(r["heater_w"] > 0 for r in rows),
        "job_steps": sum(r["executed"] == "job" for r in rows),
        "calibrations": [r["step"] for r in rows if r["executed"] == "calibrate"],
        "rejected": sum(r["requested"].get("action", "idle") != "idle" and r["executed"] == "idle" for r in rows),
        "calibration_due_step": env.k + max(0, valid - age),
        "temp_now_c": round(env.state[satellite_id]["temp_c"], 1),
    }


# ---------------------------------------------------------------- F10. Отчёт о передаче смены
def shift_report(record):
    session, planner = _restore(record)
    views = job_views(session)
    summary = session.summary()
    losses = {}
    unexplained = 0
    for j in views:
        if j["status"] != "missed":
            continue
        if j.get("loss"):
            key = (j["loss"]["group"], j["loss"]["code"])
            losses[key] = losses.get(key, 0) + 1
        else:
            unexplained += 1
    ahead = forecast(record, 24) if session.env.k < session.env.s["time"]["steps"] else None
    k = session.env.k
    hh = lambda step: f"{step * 5 // 60:02d}:{step * 5 % 60:02d}"   # noqa: E731
    group = {"problem_limit": "ограничение задачи", "planner_choice": "решение алгоритма"}
    lines = [
        f"# Передача смены — {session.env.s['meta']['title']}",
        f"Момент: шаг {k} ({hh(k)}). Цель: {'приоритетное обслуживание' if planner.goal == 'priority' else 'коммерческая отдача'}. "
        f"Алгоритм: {planner.name} {planner.version}.",
        "", "## Итог на момент передачи",
        f"- Приоритет 3 в срок: {summary['critical_jobs_completed_on_time']} из {summary['critical_jobs_due']}",
        f"- Выполнено заданий: {summary['jobs_completed']} из {summary['jobs_total']}, просрочено {summary['jobs_due_missed']}",
        f"- Выручка: ${summary['revenue_usd']:,.2f}".replace(",", " "),
        f"- Минимальный заряд: {summary['minimum_soc_pct']:.1f}%, отклонённых моделью команд: {summary['blocked_command_count']}",
        "", "## Сообщения смены",
    ]
    kinds = {"add_jobs": "новые задания", "satellite_outage": "отказ спутников", "close_downlink": "отмена сеансов связи с Землёй"}
    lines += [f"- {hh(e['at_step'])} {e['id']}: {kinds.get(e['type'], e['type'])}" for e in session.events] or ["- не было"]
    lines += ["", "## Потери по причинам"]
    lines += [f"- {group[g]} — {code}: {cnt}" for (g, code), cnt in sorted(losses.items())] or ["- потерь нет"]
    if unexplained:
        lines.append(f"- причина не установлена: {unexplained}")
    if ahead:
        lines += ["", f"## Впереди (прогноз до {hh(ahead['until_step'])})"]
        lines += [f"- {hh(a['step'])} {a['text']}" for a in ahead["alerts"][:10]] or ["- предупреждений нет"]
    return {"markdown": "\n".join(lines), "summary": summary,
            "losses": [{"group": g, "code": c, "count": n} for (g, c), n in sorted(losses.items())],
            "unexplained": unexplained, "alerts": ahead["alerts"] if ahead else []}
