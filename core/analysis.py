"""Проверяемые границы выполнимости и объяснения по фактическому журналу."""
from .availability import unavailable
from collections import defaultdict
from model.operations import replay_episode
from .errors import InputError, NotFound
from .messages import REASONS, action_text, planner_note


def impossibility(s, job):
    ids = job["eligible_satellites"]
    window = range(job["release_step"], job["deadline_step"])
    def available(sid, t):
        return not unavailable(s, sid, t)
    if not any(available(sid, t) for sid in ids for t in window):
        code, proof = "satellite_unavailable", "Все допустимые исполнители недоступны на всём окне задания."
    else:
        contact = sum(any(available(sid, t) and s["environment"][sid][job["kind"] + "_available"][t] for sid in ids) for t in window)
        if contact < job["work_steps"]:
            code = "no_contact_steps" if contact == 0 else "insufficient_contact_steps"
            proof = (f"В окне [{job['release_step']}, {job['deadline_step']}) доступно {contact} шагов "
                     f"с контактом; требуется {job['work_steps']}. На шаге допустим только один исполнитель.")
        else:
            sats = [v for v in s["satellites"] if v["id"] in ids]
            dt = s["time"]["step_s"] / 3600
            # Заведомо оптимистично: без базовой нагрузки, нагревателя, потерь и ограничения ёмкости.
            upper = sum(v["capacity_wh"] * v["initial_soc_pct"] / 100 +
                        sum(s["environment"][v["id"]]["solar_w"][:job["deadline_step"]]) * dt for v in sats)
            needed = job["work_steps"] * min(v[job["kind"] + "_w"] for v in sats) * dt
            if needed <= upper + 1e-9:
                return None
            code, proof = "energy_bound", (f"Даже оптимистичный суммарный запас {upper:.6f} Вт·ч "
                f"меньше минимальной энергии полезной нагрузки {needed:.6f} Вт·ч; остальные расходы отброшены.")
    return {"group": "problem_limit", "code": code, "proof": proof}


def _disrupted_by_event(session, job, rows):
    """Начатое задание сорвало сообщение, пришедшее после начала работы: после сообщения до срока
    у допустимых исполнителей шагов связи (вне недоступности) меньше, чем оставалось работы. Проверяемо по данным."""
    s = session.env.s
    ids = set(job["eligible_satellites"])
    def usable(sid, t):
        return s["environment"][sid][job["kind"] + "_available"][t] and not unavailable(s, sid, t)
    for ev in sorted(session.events, key=lambda e: e["at_step"]):
        at = ev["at_step"]
        if ev.get("type") not in ("satellite_outage", "close_downlink") or not ids & set(ev.get("satellite_ids", [])):
            continue
        if not job["release_step"] <= at < job["deadline_step"]:
            continue
        worked = sum(r["executed"] == "job" and r["requested"].get("job_id") == job["id"] and r["step"] < at for r in rows)
        if not worked:
            continue
        left = job["work_steps"] - worked
        contact = sum(any(usable(sid, t) for sid in ids) for t in range(at, job["deadline_step"]))
        if contact < left:
            return {"group": "problem_limit", "code": "disrupted_by_event",
                    "proof": f"Задание начато до сообщения {ev['id']} (шаг {at}); после него до срока {job['deadline_step']} "
                             f"у допустимых исполнителей {contact} шагов связи, а оставалось {left} шагов работы."}
    return None


def loss_reason(session, job, rows):
    done = job["work_steps"] - job["remaining_steps"]
    # Начатое задание, сорванное сообщением, — точнее общей невыполнимости «задним числом».
    disrupted = _disrupted_by_event(session, job, rows) if done else None
    if disrupted:
        return disrupted
    proof = impossibility(session.env.s, job)
    if proof:
        return proof
    if done:
        return {"group": "planner_choice", "code": "started_not_finished",
                "evidence": f"В журнале выполнено {done} из {job['work_steps']} шагов, срок истёк. Это факт потери работы, не доказательство её первопричины."}
    relevant = [r for r in rows if r["satellite_id"] in job["eligible_satellites"]
                and job["release_step"] <= r["step"] < job["deadline_step"]]
    for reason, code in (("energy_reserve", "energy_spent_elsewhere"), ("calibration_required", "calibration_timing"),
                         ("ground_capacity", "ground_capacity_used")):
        hits = [r for r in relevant if r["requested"].get("job_id") == job["id"] and r["reason"] == reason]
        if hits:
            # Недостаток энергии сам по себе не доказывает расход на другое задание.
            if reason == "energy_reserve" and not any(r["executed"] == "job" and r["requested"].get("job_id") != job["id"]
                for r in rows if r["satellite_id"] in job["eligible_satellites"] and r["step"] < hits[0]["step"]):
                continue
            return {"group": "planner_choice", "code": code,
                "evidence": f"Отклонённая попытка на шаге {hits[0]['step']}: {reason}. Это наблюдаемое препятствие, не доказательство глобальной невыполнимости."}
    busy = [r for r in relevant if r["executed"] == "job" and r["requested"].get("job_id") != job["id"]
            and session.env.s["environment"][r["satellite_id"]][job["kind"] + "_available"][r["step"]]]
    if busy:
        r = busy[0]
        return {"group": "planner_choice", "code": "executor_busy", "evidence":
            f"На шаге {r['step']} аппарат {r['satellite_id']} выполнял {r['requested']['job_id']} при наличии контакта для этого задания. Это конкуренция в журнале, не доказанная единственная причина потери."}
    # Контракт не содержит unknown/not_selected. Не подменяем неизвестную причину выдуманной.
    return None


def job_views(session):
    executors = defaultdict(set)
    for row in session.env.trace:
        if row["executed"] == "job":
            executors[row["requested"]["job_id"]].add(row["satellite_id"])
    sources = {j["id"]: e["id"] for e in session.events if e["type"] == "add_jobs" for j in e["jobs"]}
    fields = ("id", "kind", "priority", "value_usd", "release_step", "deadline_step", "work_steps", "eligible_satellites", "completed_step")
    output = []
    for j in session.env.jobs.values():
        done = j["work_steps"] - j["remaining_steps"]
        status = ("completed" if j["completed_step"] is not None else "missed" if j["deadline_step"] <= session.env.k
                  else "waiting" if j["release_step"] > session.env.k else "in_progress" if done else "open")
        result = {key: j[key] for key in fields}
        result["eligible_satellites"] = list(j["eligible_satellites"])
        result.update(done_steps=done, executors=sorted(executors[j["id"]]), status=status, source=sources.get(j["id"], "plan"))
        if status == "missed":
            loss = loss_reason(session, j, session.env.trace)
            if loss:
                result["loss"] = loss
        output.append(result)
    return output


def idle_reason(prefix, satellite_id, step, full_trace):
    """Почему аппарат ждал на шаге: наблюдение по состоянию и открытым заданиям на этом шаге.
    Это факт шага (что мешало), а не доказательство невыполнимости задания за всё окно."""
    env, s = prefix.env, prefix.env.s
    cap = env.sats[satellite_id]["capacity_wh"]
    if env.state[satellite_id]["energy_wh"] < cap * s["model"]["reserve_soc_pct"] / 100 - 1e-9:
        return "idle_energy_reserve", "заряд ниже резерва: модель допускает только ожидание"
    open_jobs = [j for j in env.jobs.values() if j["release_step"] <= step < j["deadline_step"]
                 and j["remaining_steps"] > 0 and satellite_id in j["eligible_satellites"]]
    if not open_jobs:
        return "idle_no_open_job", "нет открытых заданий, для которых аппарат — допустимый исполнитель"
    at_step = [r for r in full_trace if r["step"] == step]
    taken = {r["requested"]["job_id"] for r in at_step if r["executed"] == "job" and r["satellite_id"] != satellite_id}
    barriers, allowed = defaultdict(int), []
    for j in open_jobs:
        ok, reason, _ = env.can_execute(satellite_id, {"action": "job", "job_id": j["id"]})
        if not ok:
            barriers[reason] += 1
        elif j["id"] in taken:
            barriers["taken"] += 1
        else:
            allowed.append(j)
    if not allowed:
        main = max(barriers, key=barriers.get)
        text = {"no_contact": "нет связи для открытых заданий", "taken": "допустимые задания на этом шаге выполняли другие аппараты",
                "calibration_required": "нужна калибровка", "thermal_limit": "температура вне допустимого диапазона",
                "energy_reserve": "действие опустило бы заряд ниже резерва"}.get(main, REASONS.get(main, "ограничение модели"))
        return f"idle_{main}", f"{text} (заданий: {barriers[main]} из {len(open_jobs)})"
    limit = s["model"]["downlink_parallel_limit"]
    downlinks = sum(r["executed"] == "job" and env.jobs[r["requested"]["job_id"]]["kind"] == "downlink" for r in at_step)
    if all(j["kind"] == "downlink" for j in allowed) and downlinks >= limit:
        return "idle_ground_capacity", f"канал на Землю занят: уже передают {downlinks} аппарата (лимит {limit})"
    def contact(j):
        return sum(any(s["environment"][x][j["kind"] + "_available"][t] and not unavailable(s, x, t) for x in j["eligible_satellites"])
                   for t in range(step, j["deadline_step"]))
    if all(contact(j) < j["remaining_steps"] or j["deadline_step"] - step < j["remaining_steps"] for j in allowed):
        return "idle_hopeless_cut", "допустимые задания уже не успеть по сроку или шагам связи — не берутся (A10)"
    return "idle_planner_choice", (f"решение алгоритма: было допустимых заданий — {len(allowed)}, но аппарат оставлен в ожидании "
                                   "(порядок заданий и выбор исполнителя по цели и заряду)")


def explanation(session, notes, job_id, satellite_id, step):
    if (job_id is None) == (satellite_id is None):
        raise InputError("Укажите либо задание, либо аппарат и выполненный шаг")
    if job_id is not None:
        if step is not None:
            raise InputError("Для объяснения задания шаг не задаётся")
        job = session.env.jobs.get(job_id)
        if job is None:
            raise NotFound("Задание не найдено")
        loss = loss_reason(session, job, session.env.trace) if job["deadline_step"] <= session.env.k and job["completed_step"] is None else None
        result = {"subject": {"job_id": job_id}, "known_at_decision": [
            f"Объяснение по сведениям, полученным к текущему шагу {session.env.k}; не ретроспективное знание планировщика.",
            f"Окно [{job['release_step']}, {job['deadline_step']}), работа {job['work_steps']}, остаток {job['remaining_steps']}"],
            "constraint": loss["code"] if loss else None,
            "consequence": loss.get("proof", loss.get("evidence")) if loss else
                ("Задание выполнено." if job["completed_step"] is not None else "Причина не доказана доступным журналом; невыполнимость не утверждается.")}
        if loss:
            result["loss"] = loss
        return result
    if satellite_id not in session.env.sats:
        raise NotFound("Аппарат не найден")
    if type(step) is not int or not 0 <= step < session.env.k:
        raise InputError("Укажите уже выполненный шаг")
    row = next(r for r in session.env.trace if r["step"] == step and r["satellite_id"] == satellite_id)
    # Только сообщения, доступные перед этим действием; будущее исключено.
    prefix = replay_episode(session.initial_scenario,
        [e for e in session.events if e["at_step"] <= step],
        [c for c in session.commands if c["step"] < step], step)
    barriers = defaultdict(int)
    for j in prefix.env.jobs.values():
        if j["release_step"] <= step < j["deadline_step"] and j["remaining_steps"] > 0 and satellite_id in j["eligible_satellites"]:
            ok, reason, _ = prefix.env.can_execute(satellite_id, {"action": "job", "job_id": j["id"]})
            barriers["допустимо" if ok else REASONS.get(reason, "ограничение модели")] += 1
    result = {"subject": {"satellite_id": satellite_id, "step": step},
        "known_at_decision": [f"Заряд {row['energy_before_wh']} Вт·ч, температура {row['temp_before_c']} °C",
            f"Получено сообщений: {len(prefix.events)}; проверка открытых заданий: {dict(barriers)}"],
        "constraint": row["reason"] if row["reason"] not in ("accepted", "idle") else None,
        "consequence": f"Запрошено: {action_text(row['requested'])}; "
                       f"исполнено: {action_text({**row['requested'], 'action': row['executed']})}. "
                       f"Пояснение планировщика: {planner_note(notes.get(step, {}).get(satellite_id))}."}
    if row["requested"].get("action", "idle") == "idle" and row["executed"] == "idle":
        code, text = idle_reason(prefix, satellite_id, step, session.env.trace)
        result.update(constraint=code, idle_reason=code,
                      consequence=f"Ожидание на шаге {step}: {text}. Это наблюдение на шаге, а не доказательство невыполнимости.")
    if not prefix.env.available(satellite_id):
        failures = [f for f in prefix.env.s["failures"] if f["satellite_id"] == satellite_id
                    and f["start_step"] <= step < f["end_step"]]
        end = max(f["end_step"] for f in failures)
        minutes = end * prefix.env.s["time"]["step_s"] // 60
        events = [e["id"] for e in prefix.events if e["type"] == "satellite_outage"
                  and satellite_id in e["satellite_ids"] and e["at_step"] <= step < e["end_step"]]
        source = "по сообщениям " + ", ".join(events) if events else "по исходному сценарию"
        proof = f"Аппарат недоступен {source} до {minutes // 60:02d}:{minutes % 60:02d} (шаг {end})."
        result.update(constraint="satellite_unavailable", consequence=proof,
                      loss={"group": "problem_limit", "code": "satellite_unavailable", "proof": proof})
    return result
