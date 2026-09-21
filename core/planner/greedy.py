"""Эвристика по цели управления — основа основного планировщика.

Отличия от простого правила EDF (`edf.py`), каждое проверено на P02–P04:
1. Порядок заданий зависит от цели: «priority» — приоритет, затем запас времени
   (срок − шаг − остаток работы), затем стоимость; «revenue» — стоимость на шаг
   оставшейся работы, затем запас.
2. Не берутся задания, которые уже нельзя завершить: до срока осталось меньше шагов,
   чем работы, или меньше шагов с контактом у допустимых исполнителей. Работа на них
   не приносит дохода и занимает аппарат (постановка: «начатые, но не завершённые
   задания занимают ресурсы»).
3. Исполнитель — допустимый аппарат с наибольшим зарядом (в долях ёмкости).
4. Калибровка заранее: аппарат без задания на шаге калибруется, если до истечения
   срока калибровки осталось не больше `early_calibration` шагов. Так калибровка
   не отнимает шаг в момент, когда у аппарата есть работа.
Будущие шаги не рассматриваются — это делает CP-SAT в `horizon.py`.
"""
from __future__ import annotations

from .base import Admission, Planner


class GoalGreedyPlanner(Planner):
    name = "goal-greedy"
    version = "1.0"
    defaults = {"early_calibration": 8}

    def __init__(self, goal="priority", **params):
        unknown = set(params) - set(self.defaults)
        if unknown:
            raise ValueError(f"Неизвестные настройки: {sorted(unknown)}")
        settings = {**self.defaults, **params}
        if type(settings["early_calibration"]) is not int or settings["early_calibration"] < 0:
            raise ValueError("early_calibration: требуется целое неотрицательное число")
        super().__init__(goal, **settings)

    @staticmethod
    def _contact_steps(env, job, k) -> int:
        """Сколько шагов до срока хотя бы у одного допустимого исполнителя есть контакт."""
        series = [env.s["environment"][sid][job["kind"] + "_available"] for sid in job["eligible_satellites"]]
        return sum(any(av[t] for av in series) for t in range(k, job["deadline_step"]))

    def _key(self, job, k):
        slack = (job["deadline_step"] - k) - job["remaining_steps"]
        if self.goal == "priority":
            return (-job["priority"], slack, -job["value_usd"], job["id"])
        return (-job["value_usd"] / job["remaining_steps"], slack, job["id"])

    def decide(self, session) -> dict[str, dict]:
        env = session.env
        k = env.k
        valid = env.s["model"]["calibration_valid_steps"]
        adm = Admission(env)
        notes: dict[str, str] = {}
        for sid in sorted(env.sats):
            if env.state[sid]["calibration_age_steps"] >= valid and adm.add(sid, {"action": "calibrate"})[0]:
                notes[sid] = "calibration_expired"
        feasible = [j for j in env.jobs.values()
                    if j["completed_step"] is None and j["release_step"] <= k < j["deadline_step"]
                    and j["deadline_step"] - k >= j["remaining_steps"]
                    and self._contact_steps(env, j, k) >= j["remaining_steps"]]
        for job in sorted(feasible, key=lambda j: self._key(j, k)):
            by_charge = sorted(job["eligible_satellites"],
                               key=lambda s: (-env.state[s]["energy_wh"] / env.sats[s]["capacity_wh"], s))
            for sid in by_charge:
                if sid not in adm.accepted and adm.add(sid, {"action": "job", "job_id": job["id"]})[0]:
                    notes[sid] = "goal_priority" if self.goal == "priority" else "goal_revenue"
                    break
        early = self.params["early_calibration"]
        if early:
            for sid in sorted(env.sats):
                if (sid not in adm.accepted and env.state[sid]["calibration_age_steps"] >= valid - early
                        and adm.add(sid, {"action": "calibrate"})[0]):
                    notes[sid] = "calibration_ahead"
        self.last_notes = notes
        return adm.accepted
