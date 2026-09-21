"""Расширенная модель: ориентация аппарата, светотень и служебный сеанс связи (О7).

Официальная модель (`model/`) не меняется — расширение наследует её `Environment`
и добавляет три явления, которых в ней нет. Все параметры — допущения команды
(A11–A14 в docs/ASSUMPTIONS.md) и задаются в `EXT_DEFAULTS`.

1. Ориентация и светотень. В официальной модели генерация зависит только от того,
   освещён ли аппарат (solar_w: 125 Вт на свету, 0 в тени), а ориентация не учитывается.
   Здесь у аппарата есть режим наведения: «солнце» (ожидание — панели на Солнце),
   «земля» (передача на Землю, служебный сеанс), «ретранслятор», «звёзды» (калибровка).
   В любом режиме, кроме «солнце», панели отвёрнуты: генерация умножается на
   `pointing_solar_factor`. В тени множитель ничего не меняет — генерации и так нет,
   поэтому работа в тени «дешевле» по ориентации, чем на свету.
2. Разворот. Смена режима наведения между шагами стоит `slew_wh` энергии
   (маховики/двигатели ориентации). Разворот — часть шага, отдельного шага не занимает.
3. Служебный сеанс связи `{"action": "link"}`: аппарат держит канал с Землёй без задания
   (телеметрия и приём команд). Нужен контакт downlink, тратит `link_w_share` от мощности
   передатчика, занимает один из общих каналов наземной связи (тот же лимит, что у передачи).
   Постановщик: «если нужно постоянно держать связь с Землёй, один аппарат точно должен
   быть на связи» — в официальной модели держать связь без задания нельзя.

С параметрами NEUTRAL (множитель 1, разворот 0) расширение повторяет официальную модель
побитно — это проверяет tests/test_extended.py.
"""
from __future__ import annotations

import copy

from model.operations import Session, digest
from model.resource_env import Environment

EXT_DEFAULTS = {"pointing_solar_factor": 0.6, "slew_wh": 0.5, "link_w_share": 0.25}
NEUTRAL = {"pointing_solar_factor": 1.0, "slew_wh": 0.0, "link_w_share": 0.25}
MODES = ("sun", "earth", "relay", "star")


def mode_of(env: Environment, action: dict | None) -> str:
    kind = (action or {}).get("action", "idle")
    if kind == "calibrate":
        return "star"
    if kind == "link":
        return "earth"
    if kind == "job":
        job = env.jobs.get(action.get("job_id"))
        return "earth" if job and job["kind"] == "downlink" else "relay"
    return "sun"


def validate_params(params: dict) -> dict:
    p = {**EXT_DEFAULTS, **(params or {})}
    if set(p) - set(EXT_DEFAULTS):
        raise ValueError(f"Неизвестные настройки расширенной модели: {sorted(set(p) - set(EXT_DEFAULTS))}")
    for key, lo, hi in (("pointing_solar_factor", 0, 1), ("slew_wh", 0, 100), ("link_w_share", 0, 1)):
        v = p[key]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
            raise ValueError(f"{key}: требуется число от {lo} до {hi}")
    return p


class ExtendedEnvironment(Environment):
    def __init__(self, scenario: dict, params: dict | None = None):
        super().__init__(scenario)
        self.ext = validate_params(params)
        for st in self.state.values():
            st["attitude"] = "sun"
        self._mode: dict[str, str] = {}     # режим запрошенного действия — для transition

    def _extra(self, sid: str, mode: str) -> tuple[float, float]:
        """Потеря генерации (Вт) и энергия разворота (Вт·ч) для режима на текущем шаге."""
        solar = self.s["environment"][sid]["solar_w"][self.k]
        lost_w = 0.0 if mode == "sun" else solar * (1 - self.ext["pointing_solar_factor"])
        slew = self.ext["slew_wh"] if mode != self.state[sid]["attitude"] else 0.0
        return lost_w, slew

    def transition(self, sid: str, payload_w: float):
        # Потеря генерации и разворот учитываются как дополнительная нагрузка того же шага,
        # поэтому КПД заряда/разряда, резерв и нагрев считаются по формулам официальной модели.
        lost_w, slew_wh = self._extra(sid, self._mode.get(sid, "sun"))
        extra_w = lost_w + slew_wh * 3600 / self.s["time"]["step_s"]
        return super().transition(sid, payload_w + extra_w)

    def can_execute(self, sid: str, action: dict):
        self._mode[sid] = mode_of(self, action)
        if action.get("action") != "link":
            return super().can_execute(sid, action)
        if sid not in self.sats:
            return False, "unknown_satellite", 0
        if not self.available(sid):
            return False, "satellite_unavailable", 0
        if not self.s["environment"][sid]["downlink_available"][self.k]:
            return False, "no_contact", 0
        v, st, m = self.sats[sid], self.state[sid], self.s["model"]
        power = v["downlink_w"] * self.ext["link_w_share"]
        en, temp, _, _ = self.transition(sid, power)
        reserve = v["capacity_wh"] * m["reserve_soc_pct"] / 100 - 1e-09
        if st["energy_wh"] < reserve or en < reserve:
            return False, "energy_reserve", 0
        if not (m["payload_min_c"] <= st["temp_c"] <= m["payload_max_c"] and m["payload_min_c"] <= temp <= m["payload_max_c"]):
            return False, "thermal_limit", 0
        return True, "accepted", power

    def step(self, actions: dict[str, dict]) -> list[dict]:
        """Шаг официальной модели + режим наведения, разворот и служебный сеанс связи."""
        if self.k >= self.s["time"]["steps"]:
            raise ValueError("Simulation is finished")
        if set(actions) - set(self.sats):
            raise ValueError("Unknown satellite in commands")
        used_jobs, downlinks, rows = set(), 0, []
        m = self.s["model"]
        for sid in sorted(self.sats):
            requested = actions.get(sid, {"action": "idle"})
            ok, reason, power = self.can_execute(sid, requested)
            j = self.jobs.get(requested.get("job_id")) if requested.get("action") == "job" else None
            ground = requested.get("action") == "link" or (j is not None and j["kind"] == "downlink")
            if ok and j and j["id"] in used_jobs:
                ok, reason, power = False, "duplicate_job_in_step", 0
            elif ok and ground and downlinks >= m["downlink_parallel_limit"]:
                ok, reason, power = False, "ground_capacity", 0
            actual = requested.get("action", "idle") if ok else "idle"
            self._mode[sid] = mode_of(self, requested if ok else None)
            st = self.state[sid]
            before = dict(st)
            lost_w, slew_wh = self._extra(sid, self._mode[sid])
            en, temp, heater, load_w = self.transition(sid, power)
            st["energy_wh"] = min(self.sats[sid]["capacity_wh"], max(0.0, en))
            st["temp_c"] = temp
            st["calibration_age_steps"] = 0 if actual == "calibrate" else st["calibration_age_steps"] + 1
            st["attitude"] = self._mode[sid]
            completed = None
            if ok and ground:
                downlinks += 1
            if ok and actual == "job":
                used_jobs.add(j["id"])
                j["remaining_steps"] -= 1
                if j["remaining_steps"] == 0:
                    j["completed_step"] = self.k + 1
                    completed = j["id"]
                    self.completed.append(j["id"])
            cap = self.sats[sid]["capacity_wh"]
            rows.append({"step": self.k, "satellite_id": sid, "requested": requested, "executed": actual, "reason": reason,
                         "energy_before_wh": round(before["energy_wh"], 6), "energy_after_wh": round(st["energy_wh"], 6),
                         "temp_before_c": round(before["temp_c"], 6), "temp_after_c": round(temp, 6),
                         "solar_w": self.s["environment"][sid]["solar_w"][self.k], "heater_w": heater, "load_w": load_w,
                         "calibration_age_steps": st["calibration_age_steps"], "completed_job": completed,
                         "brownout": en < 0, "below_reserve": st["energy_wh"] < cap * m["reserve_soc_pct"] / 100 - 1e-09,
                         "attitude": st["attitude"], "slew": slew_wh > 0, "solar_lost_w": round(lost_w, 6)})
        self.trace.extend(rows)
        self.k += 1
        return rows


class ExtendedSession(Session):
    """Session официальной модели с расширенной средой. События и журнал — те же."""

    def __init__(self, scenario: dict, run_metadata: dict | None = None, params: dict | None = None):
        super().__init__(scenario, run_metadata)
        self.ext_params = validate_params(params)
        self.env = ExtendedEnvironment(scenario, self.ext_params)

    def advance(self, actions: dict[str, dict]) -> list[dict]:
        link = {sid: a for sid, a in actions.items() if isinstance(a, dict) and a.get("action") == "link"}
        for sid, a in link.items():
            if set(a) != {"action"}:
                raise ValueError(f"Invalid action fields for {sid}")
        rest = {sid: a for sid, a in actions.items() if sid not in link}
        saved = copy.deepcopy(actions)
        step = self.env.k
        if set(saved) - set(self.env.sats):
            raise ValueError("Unknown satellite in actions")
        for sid, a in rest.items():
            if not isinstance(a, dict) or a.get("action") not in ("idle", "calibrate", "job"):
                raise ValueError(f"Unknown action for {sid}")
            expected = {"action", "job_id"} if a["action"] == "job" else {"action"}
            if set(a) != expected or ("job_id" in a and not isinstance(a["job_id"], str)):
                raise ValueError(f"Invalid action fields for {sid}")
        rows = self.env.step(saved)
        self.commands.extend(dict(a, step=step, satellite_id=sid) for sid, a in saved.items())
        return rows

    def summary(self) -> dict:
        s = super().summary()
        s.update(extended_metrics(self.env))
        return s


def extended_metrics(env: ExtendedEnvironment) -> dict:
    """Показатели расширения: развороты, потерянная генерация, непрерывность связи."""
    trace = env.trace
    n = env.k
    contact = [any(env.s["environment"][sid]["downlink_available"][t] for sid in env.sats) for t in range(n)]
    on_link = [False] * n
    for r in trace:
        if r["executed"] == "link" or (r["executed"] == "job" and env.jobs[r["requested"]["job_id"]]["kind"] == "downlink"):
            on_link[r["step"]] = True
    covered = sum(on_link[t] for t in range(n) if contact[t])
    gaps, run = 0, 0
    for t in range(n):
        run = run + 1 if contact[t] and not on_link[t] else 0
        gaps = max(gaps, run)
    dt_h = env.s["time"]["step_s"] / 3600
    return {"ext_slews": sum(r.get("slew", False) for r in trace),
            "ext_solar_lost_wh": round(sum(r.get("solar_lost_w", 0.0) for r in trace) * dt_h, 6),
            "ext_link_steps": sum(r["executed"] == "link" for r in trace),
            "ext_link_coverage": round(covered / max(1, sum(contact)), 6),
            "ext_longest_link_gap_steps": gaps}


def replay_extended(scenario: dict, events: list[dict], commands: list[dict], params: dict | None = None) -> ExtendedSession:
    """Повтор сохранённой смены в расширенной модели (события — на своих шагах, до команд)."""
    by_step: dict[int, dict] = {}
    for c in commands:
        by_step.setdefault(c["step"], {})[c["satellite_id"]] = {k: v for k, v in c.items() if k not in ("step", "satellite_id")}
    ev: dict[int, list] = {}
    for e in events:
        ev.setdefault(e["at_step"], []).append(e)
    last = max([c["step"] + 1 for c in commands] + [0])
    session = ExtendedSession(scenario, params=params)
    while session.env.k < last:
        for e in ev.get(session.env.k, []):
            session.apply_event(e)
        session.advance(by_step.get(session.env.k, {}))
    return session


def state_digest(session: ExtendedSession) -> str:
    return digest({"step": session.env.k, "state": session.env.state, "jobs": session.env.jobs})
