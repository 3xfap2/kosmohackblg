"""Прогноз энергии и температуры по тем же формулам, что model/resource_env.py.

Планировщику нужно заранее знать, сколько энергии съест каждое действие на каждом
шаге окна. Нагрузка задаётся действием, солнце и тепловой режим — рядами сценария,
поэтому приращение энергии для пары «шаг × тип действия» — константа, если известна
температура (она включает нагреватель и разрешает зарядку).
"""
from __future__ import annotations

import math

ACTION_KINDS = ("idle", "relay", "downlink", "calibrate")


def payload_w(sat: dict, kind: str) -> float:
    if kind == "idle":
        return 0.0
    if kind == "calibrate":
        return sat["calibration_w"]
    return sat[kind + "_w"]


def step_delta(sat: dict, model: dict, solar: float, thermal_target: float,
               temp: float, payload: float, dt: float = 300.0) -> tuple[float, float]:
    """Возвращает (ΔE до ограничения ёмкостью, температура в конце шага)."""
    heater = sat["heater_w"] if temp < model["heater_below_c"] else 0.0
    load = sat["base_w"] + heater + payload
    delta = (solar - load) * dt / 3600
    if delta >= 0:
        delta = delta * model["charge_efficiency"] if model["charge_min_c"] <= temp <= model["charge_max_c"] else 0.0
    else:
        delta /= model["discharge_efficiency"]
    eq = thermal_target + model["thermal_gain_c_per_w"] * load
    t_next = eq + (temp - eq) * math.exp(-dt / model["thermal_tau_s"])
    return delta, t_next


def forecast(scenario: dict, sid: str, k0: int, k1: int, temp0: float,
             kinds: dict[int, str] | None = None) -> dict:
    """Прогноз на шагах [k0, k1): температура в начале шага и ΔE каждого действия.

    Температурная траектория строится по ожидаемым действиям (kinds, по умолчанию —
    ожидание); ΔE считается для каждого возможного действия от этой температуры.
    """
    sat = next(v for v in scenario["satellites"] if v["id"] == sid)
    env = scenario["environment"][sid]
    model = scenario["model"]
    dt = scenario["time"]["step_s"]
    temps, deltas, end_temps = [], [], []
    t = temp0
    for k in range(k0, k1):
        row, ends = {}, {}
        for kind in ACTION_KINDS:
            row[kind], ends[kind] = step_delta(sat, model, env["solar_w"][k], env["thermal_target_c"][k],
                                               t, payload_w(sat, kind), dt)
        temps.append(t)
        deltas.append(row)
        end_temps.append(ends)
        t = ends[(kinds or {}).get(k, "idle")]
    return {"temp": temps, "delta": deltas, "end_temp": end_temps}
