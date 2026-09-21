from __future__ import annotations

from typing import Any

GOALS = ("priority", "revenue")


class Planner:
    """Выбирает действия всех аппаратов на текущий шаг.

    Внутреннее состояние (кэш плана) принадлежит ветви: при сравнении планировщик
    копируется вместе с Session через copy.deepcopy.
    """
    name = "planner"
    version = "1.0"

    def __init__(self, goal: str = "priority", **params: Any):
        if goal not in GOALS:
            raise ValueError(f"Неизвестная цель управления: {goal}")
        self.goal = goal
        self.params = params
        # Пояснения к последнему решению: {sat_id: код причины}.
        self.last_notes: dict[str, str] = {}

    def set_goal(self, goal: str) -> None:
        if goal not in GOALS:
            raise ValueError(f"Неизвестная цель управления: {goal}")
        self.goal = goal

    def metadata(self) -> dict:
        return {"algorithm": self.name, "version": self.version, "goal": self.goal,
                "parameters": dict(self.params)}

    def to_state(self) -> dict:
        return {}

    def from_state(self, state: dict) -> None:
        if state != {}:
            raise ValueError("Некорректное состояние EDF")

    def decide(self, session) -> dict[str, dict]:
        raise NotImplementedError


class Admission:
    """Согласует действия шага так же, как это сделает модель при исполнении.

    Проверяет допуск действия, лимит одновременных downlink и то, что над заданием
    работает один аппарат. Действия добавляются по одному.
    """

    def __init__(self, env):
        self.env = env
        self.limit = env.s["model"]["downlink_parallel_limit"]
        self.used_jobs: set[str] = set()
        self.downlinks = 0
        self.accepted: dict[str, dict] = {}

    def check(self, sid: str, action: dict) -> tuple[bool, str]:
        if sid in self.accepted:
            return False, "satellite_busy"
        ok, reason, _ = self.env.can_execute(sid, action)
        if ok and action["action"] == "job":
            job = self.env.jobs[action["job_id"]]
            if job["id"] in self.used_jobs:
                return False, "duplicate_job_in_step"
            if job["kind"] == "downlink" and self.downlinks >= self.limit:
                return False, "ground_capacity"
        return ok, reason

    def add(self, sid: str, action: dict) -> tuple[bool, str]:
        ok, reason = self.check(sid, action)
        if ok:
            self.accepted[sid] = action
            if action["action"] == "job":
                job = self.env.jobs[action["job_id"]]
                self.used_jobs.add(job["id"])
                self.downlinks += job["kind"] == "downlink"
        return ok, reason


def make_planner(name: str, goal: str = "priority", **params: Any) -> Planner:
    if name not in PLANNERS:
        raise ValueError(f"Неизвестный алгоритм: {name}")
    return PLANNERS[name](goal=goal, **params)


from .edf import EDFPlanner  # noqa: E402
from .greedy import GoalGreedyPlanner  # noqa: E402
from .horizon import HorizonPlanner  # noqa: E402

PLANNERS = {EDFPlanner.name: EDFPlanner, GoalGreedyPlanner.name: GoalGreedyPlanner,
            HorizonPlanner.name: HorizonPlanner}
