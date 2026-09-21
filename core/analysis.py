"""Проверяемые границы выполнимости и объяснения по фактическому журналу."""
from collections import defaultdict
from model.operations import replay_episode
from .errors import InputError, NotFound


def impossibility(s, job):
    ids = job["eligible_satellites"]
    window = range(job["release_step"], job["deadline_step"])
    def available(sid, t):
        return not any(f["satellite_id"] == sid and f["start_step"] <= t < f["end_step"] for f in s["failures"])
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


def loss_reason(session, job, rows):
    proof = impossibility(session.env.s, job)
    if proof:
        return proof
    done = job["work_steps"] - job["remaining_steps"]
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
            barriers["допустимо" if ok else reason] += 1
    return {"subject": {"satellite_id": satellite_id, "step": step},
        "known_at_decision": [f"Заряд {row['energy_before_wh']} Вт·ч, температура {row['temp_before_c']} °C",
            f"Получено сообщений: {len(prefix.events)}; проверка открытых заданий: {dict(barriers)}"],
        "constraint": row["reason"] if row["reason"] not in ("accepted", "idle") else None,
        "consequence": f"Запрошено {row['requested']}; исполнено {row['executed']}. "
                       f"Пояснение планировщика: {notes.get(step, {}).get(satellite_id, 'нет записи; причина простоя не доказана')}."}
