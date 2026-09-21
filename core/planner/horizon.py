"""Основной планировщик: CP-SAT на скользящем окне с «ремонтом» плана.

На шаге k строится модель на окне [k, k + horizon):
  * x[s, j, t] — аппарат s выполняет задание j на шаге t (только если есть контакт,
    аппарат доступен и задание открыто);
  * c[s, t] — калибровка;
  * e[s, t] — энергия на границе шага (в сотых долях Вт·ч).

Ограничения повторяют правила модели: одно действие на аппарат, один исполнитель
задания на шаге, не более downlink_parallel_limit передач на Землю, резерв заряда
в начале и в конце операции, действующая калибровка. Энергия описана неравенством
e[t+1] <= e[t] + ΔE(действие), поэтому план по энергии консервативен: фактический
заряд не ниже расчётного (реальная модель лишь обрезает по ёмкости и нулю).

Цель «priority» лексикографически ставит завершение заданий приоритета 3 выше
выручки, цель «revenue» максимизирует выручку. Остаток энергии в конце окна имеет
небольшую ценность, чтобы окно не «выжигало» батареи перед своей границей.

План исполняется по шагам. Перед каждым шагом действия проверяются допуском модели;
пересчёт выполняется по расписанию, после события, смены цели или отказа действия.
"""
from __future__ import annotations

import math

from ortools.sat.python import cp_model

from .base import Admission, Planner
from .edf import EDFPlanner
from .physics import forecast

SCALE = 100          # единица энергии в модели — 0,01 Вт·ч
MILLS = 1000         # единица целевой функции — 0,001 доллара


class HorizonPlanner(Planner):
    name = "horizon-cpsat"
    version = "1.0"
    defaults = {"horizon": 48, "replan_every": 6, "time_limit_s": 2.0, "workers": 8,
                "energy_value_usd_per_wh": 0.5, "seed": 7}

    def __init__(self, goal: str = "priority", **params):
        super().__init__(goal, **{**self.defaults, **params})
        self.plan: dict[int, dict[str, dict]] = {}
        self.plan_from = -1
        self.plan_goal = None
        self.seen_events = 0
        self.need_replan = True
        self.last_solve: dict = {}
        self.solves: list[dict] = []

    # ---------------------------------------------------------------- решение
    def decide(self, session) -> dict[str, dict]:
        env = session.env
        k = env.k
        p = self.params
        if (self.need_replan or k not in self.plan or k - self.plan_from >= p["replan_every"]
                or len(session.events) != self.seen_events or self.plan_goal != self.goal):
            self._solve(session)
        if self.last_solve.get("fallback"):
            fb = EDFPlanner(self.goal)
            actions = fb.decide(session)
            self.last_notes = {sid: "fallback_" + r for sid, r in fb.last_notes.items()}
            return actions
        adm = Admission(env)
        notes: dict[str, str] = {}
        for sid, action in sorted(self.plan.get(k, {}).items()):
            ok, reason = adm.add(sid, action)
            if ok:
                notes[sid] = "planned"
            else:
                notes[sid] = "plan_rejected:" + reason
                self.need_replan = True
        self.last_notes = notes
        return adm.accepted

    # ---------------------------------------------------------------- модель
    def _solve(self, session) -> None:
        env = session.env
        s = env.s
        p = self.params
        model_p = s["model"]
        k0 = env.k
        n = s["time"]["steps"]
        k1 = min(n, k0 + p["horizon"])
        steps = range(k0, k1)
        valid = model_p["calibration_valid_steps"]
        pay_lo, pay_hi = model_p["payload_min_c"], model_p["payload_max_c"]

        def available(sid: str, t: int) -> bool:
            return not any(f["satellite_id"] == sid and f["start_step"] <= t < f["end_step"]
                           for f in s["failures"])

        m = cp_model.CpModel()
        fc = {sid: forecast(s, sid, k0, k1, env.state[sid]["temp_c"]) for sid in env.sats}
        avail = {sid: [available(sid, t) for t in steps] for sid in env.sats}

        # --- задания
        x: dict[tuple[str, str, int], cp_model.IntVar] = {}
        by_sat_t: dict[tuple[str, int], dict[str, list]] = {}
        job_vars: dict[str, cp_model.IntVar] = {}
        open_jobs = [j for j in env.jobs.values()
                     if j["completed_step"] is None and j["remaining_steps"] > 0
                     and j["deadline_step"] > k0 and j["release_step"] < k1]
        for j in open_jobs:
            kind = j["kind"]
            lo, hi = max(k0, j["release_step"]), min(j["deadline_step"], k1)
            cells = []
            usable_steps = set()
            for t in range(lo, hi):
                i = t - k0
                for sid in j["eligible_satellites"]:
                    if not avail[sid][i] or not s["environment"][sid][kind + "_available"][t]:
                        continue
                    f = fc[sid]
                    if not (pay_lo <= f["temp"][i] <= pay_hi and pay_lo <= f["end_temp"][i][kind] <= pay_hi):
                        continue
                    cells.append((sid, t))
                    usable_steps.add(t)
            if len(usable_steps) < j["remaining_steps"]:
                continue  # в окне нельзя завершить: не хватает шагов с контактом
            vs = []
            per_t: dict[int, list] = {}
            for sid, t in cells:
                v = m.NewBoolVar(f"x_{sid}_{j['id']}_{t}")
                x[(sid, j["id"], t)] = v
                vs.append(v)
                per_t.setdefault(t, []).append(v)
                by_sat_t.setdefault((sid, t), {"relay": [], "downlink": []})[kind].append(v)
            for group in per_t.values():
                if len(group) > 1:
                    m.AddAtMostOne(group)
            y = m.NewBoolVar(f"y_{j['id']}")
            m.Add(sum(vs) <= j["remaining_steps"])
            m.Add(sum(vs) >= j["remaining_steps"] * y)
            job_vars[j["id"]] = y

        # --- калибровка, энергия, допуск
        cal: dict[tuple[str, int], cp_model.IntVar] = {}
        objective = []
        energy_coef = int(round(p["energy_value_usd_per_wh"] * MILLS / SCALE))
        for sid in sorted(env.sats):
            sat = env.sats[sid]
            f = fc[sid]
            cap = int(math.floor(sat["capacity_wh"] * SCALE))
            reserve = int(math.ceil(sat["capacity_wh"] * model_p["reserve_soc_pct"] / 100 * SCALE)) + 1
            lo_e = -2 * cap
            e_prev = m.NewConstant(int(math.floor(env.state[sid]["energy_wh"] * SCALE)))
            age0 = env.state[sid]["calibration_age_steps"]
            for t in steps:
                i = t - k0
                d = {kind: int(math.floor(v * SCALE)) for kind, v in f["delta"][i].items()}
                groups = by_sat_t.get((sid, t), {"relay": [], "downlink": []})
                rel, dl = groups["relay"], groups["downlink"]
                c = None
                if (avail[sid][i] and pay_lo <= f["temp"][i] <= pay_hi
                        and pay_lo <= f["end_temp"][i]["calibrate"] <= pay_hi):
                    c = m.NewBoolVar(f"c_{sid}_{t}")
                    cal[(sid, t)] = c
                acts = rel + dl + ([c] if c is not None else [])
                if len(acts) > 1:
                    m.AddAtMostOne(acts)
                nxt = m.NewIntVar(lo_e, cap, f"e_{sid}_{t + 1}")
                flow = d["idle"] + (d["relay"] - d["idle"]) * sum(rel) + (d["downlink"] - d["idle"]) * sum(dl)
                if c is not None:
                    flow += (d["calibrate"] - d["idle"]) * c
                m.Add(nxt <= e_prev + flow)
                if acts:
                    busy = sum(acts)
                    # busy = 1 -> e[t] >= reserve и e[t+1] >= reserve
                    m.Add(e_prev - (reserve - lo_e) * busy >= lo_e)
                    m.Add(nxt - (reserve - lo_e) * busy >= lo_e)
                    jobs_here = rel + dl
                    if jobs_here and age0 + i >= valid:
                        window = [cal[(sid, tc)] for tc in range(max(k0, t - valid), t) if (sid, tc) in cal]
                        m.Add(sum(jobs_here) <= sum(window))
                e_prev = nxt
            if k1 < n:
                objective.append(energy_coef * e_prev)

        # --- общий ресурс наземной связи
        limit = model_p["downlink_parallel_limit"]
        for t in steps:
            dls = [v for sid in env.sats for v in by_sat_t.get((sid, t), {"downlink": []})["downlink"]]
            if len(dls) > limit:
                m.Add(sum(dls) <= limit)

        # --- цель
        p3_weight = 100_000 * MILLS if self.goal == "priority" else 0
        for jid, y in job_vars.items():
            j = env.jobs[jid]
            w = int(round(j["value_usd"] * MILLS)) + (p3_weight if j["priority"] == 3 else 0)
            objective.append(w * y)
        objective.append(-1 * sum(x.values()))
        objective.append(-50 * sum(cal.values()))
        m.Maximize(sum(objective))

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = p["time_limit_s"]
        solver.parameters.num_workers = p["workers"]
        solver.parameters.random_seed = p["seed"]
        status = solver.Solve(m)
        ok = status in (cp_model.OPTIMAL, cp_model.FEASIBLE)
        self.plan = {}
        if ok:
            for (sid, jid, t), v in x.items():
                if solver.Value(v):
                    self.plan.setdefault(t, {})[sid] = {"action": "job", "job_id": jid}
            for (sid, t), v in cal.items():
                if solver.Value(v):
                    self.plan.setdefault(t, {})[sid] = {"action": "calibrate"}
            for t in steps:
                self.plan.setdefault(t, {})
        self.plan_from = k0
        self.plan_goal = self.goal
        self.seen_events = len(session.events)
        self.need_replan = False
        self.last_solve = {
            "step": k0, "horizon_end": k1, "status": solver.StatusName(status),
            "fallback": not ok, "variables": len(x) + len(cal), "jobs_in_model": len(job_vars),
            "planned_completions": sum(solver.Value(y) for y in job_vars.values()) if ok else 0,
            "wall_s": round(solver.WallTime(), 3),
        }
        self.solves.append(self.last_solve)
