"""Простое правило для сравнения: ближайший срок первым (EDF).

1. Аппарат с истёкшей калибровкой калибруется, если это допустимо.
2. Открытые задания сортируются по сроку, затем по приоритету (или по стоимости
   в режиме «Коммерческая отдача»).
3. Каждое задание получает первый свободный допустимый аппарат, прошедший проверку
   допуска. Будущие шаги не рассматриваются.
"""
from __future__ import annotations

from .base import Admission, Planner


class EDFPlanner(Planner):
    name = "edf-baseline"
    version = "1.0"

    def __init__(self, goal="priority", **params):
        if params:
            raise ValueError("EDF не принимает дополнительные настройки")
        super().__init__(goal)

    def decide(self, session) -> dict[str, dict]:
        env = session.env
        k = env.k
        valid = env.s["model"]["calibration_valid_steps"]
        adm = Admission(env)
        notes: dict[str, str] = {}
        for sid in sorted(env.sats):
            if env.state[sid]["calibration_age_steps"] >= valid and adm.add(sid, {"action": "calibrate"})[0]:
                notes[sid] = "calibration_expired"
        tiebreak = (lambda j: -j["priority"]) if self.goal == "priority" else (lambda j: -j["value_usd"])
        open_jobs = sorted((j for j in env.jobs.values()
                            if j["completed_step"] is None and j["release_step"] <= k < j["deadline_step"]),
                           key=lambda j: (j["deadline_step"], tiebreak(j), j["id"]))
        for job in open_jobs:
            for sid in job["eligible_satellites"]:
                if sid not in adm.accepted and adm.add(sid, {"action": "job", "job_id": job["id"]})[0]:
                    notes[sid] = "earliest_deadline"
                    break
        self.last_notes = notes
        return adm.accepted
