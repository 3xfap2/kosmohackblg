"""Чистые функции над RunRecord. Учёт выполняет только официальная Session."""
from __future__ import annotations
import copy
import hashlib
import hmac
import os
import re
from functools import lru_cache
import math
from pathlib import Path
import time
from uuid import uuid4

from model.operations import RESULT_SCHEMA, Session, digest, replay_episode
from model.resource_env import load, validate
from .errors import InputError, NotFound
from .messages import model_error
from .planner import make_planner

ROOT = Path(__file__).resolve().parents[1]


# Подпись записи смены. Сервер без состояния: запись приходит от клиента в каждом запросе, и без подписи
# клиент мог бы переписать историю (например, вставить сообщение задним числом). Подпись — HMAC-SHA256 по
# содержимому записи, кроме id (метка в браузере) и самой подписи. Числа приводятся к единому виду:
# JavaScript превращает 125.0 в 125, и без этого подпись ломалась бы при обычной пересылке через браузер.
def _record_secret() -> bytes:
    """Секрет подписи. На Vercel обязателен из окружения (все экземпляры должны подписывать одинаково);
    локально без переменной — случайный, создаётся один раз в .local_record_secret (вне git)."""
    value = os.environ.get("SOZVEZDIE_RECORD_SECRET", "")
    if value:
        return value.encode()
    if os.environ.get("VERCEL"):
        raise RuntimeError("SOZVEZDIE_RECORD_SECRET не задан: на развёртывании подпись записей обязательна")
    path = ROOT / ".local_record_secret"
    try:
        if not path.exists():
            import secrets
            path.write_text(secrets.token_hex(32), encoding="utf-8")
        return path.read_text(encoding="utf-8").strip().encode()
    except OSError:
        import secrets
        return secrets.token_hex(32).encode()   # только на время процесса


_SECRET = _record_secret()


def _canon(x):
    if isinstance(x, float) and x.is_integer():
        return int(x)
    if isinstance(x, dict):
        return {k: _canon(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_canon(v) for v in x]
    return x


def _signature(record):
    body = {k: v for k, v in record.items() if k not in ("id", "signature")}
    if isinstance(body.get("run_metadata"), dict):
        # parent не входит в подпись: сравнение всё равно проверяет общее состояние повтором префикса
        body["run_metadata"] = {k: v for k, v in body["run_metadata"].items() if k != "parent"}
    return hmac.new(_SECRET, digest(_canon(body)).encode(), hashlib.sha256).hexdigest()


def _signed(record):
    return {**record, "signature": _signature(record)}


@lru_cache(maxsize=4)
def _builtin(ref):
    # Идентификатор сопоставляется с явным перечнем; файловые пути не принимаются.
    files = {p.stem: p for p in (ROOT / "data").glob("*.json")}
    if not isinstance(ref, str) or ref not in files:
        raise NotFound("Встроенный сценарий не найден")
    return load(files[ref])


def _source(source):
    if not isinstance(source, dict) or set(source) - {"ref", "inline", "overrides"} or ("ref" in source) == ("inline" in source):
        raise InputError("Укажите один источник: ref или inline")
    if "ref" in source and not isinstance(source["ref"], str):
        raise InputError("ref должен быть строкой")
    s = copy.deepcopy(_builtin(source["ref"]) if "ref" in source else source["inline"])
    try:
        validate(s)
        changes = source.get("overrides", {})
        if not isinstance(changes, dict) or set(changes) - {"initial_soc_pct", "solar_factor", "job_priority", "failures"}:
            raise ValueError("Неизвестные поля изменения сценария")
        sats, jobs = {v["id"]: v for v in s["satellites"]}, {j["id"]: j for j in s["jobs"]}
        for key, items, target in (("initial_soc_pct", sats, "initial_soc_pct"), ("job_priority", jobs, "priority")):
            values = changes.get(key, {})
            if not isinstance(values, dict) or set(values) - set(items):
                raise ValueError(f"{key}: неизвестные идентификаторы или неверный формат")
            for identifier, value in values.items():
                items[identifier][target] = value
        factor = changes.get("solar_factor", 1)
        if isinstance(factor, bool) or not isinstance(factor, (int, float)) or not math.isfinite(factor) or factor <= 0:
            raise ValueError("Множитель солнечной мощности должен быть конечным и положительным")
        for env in s["environment"].values():
            env["solar_w"] = [v * factor for v in env["solar_w"]]
        # Известный заранее период недоступности аппарата (постановка, п. 1): формат и границы проверяет validate модели.
        extra = changes.get("failures", [])
        if not isinstance(extra, list) or any(not isinstance(f, dict) or set(f) != {"satellite_id", "start_step", "end_step"} for f in extra):
            raise ValueError("failures: список {satellite_id, start_step, end_step}")
        s["failures"] = s["failures"] + copy.deepcopy(extra)
        if changes:
            original = s["meta"]["id"]
            s["meta"].update(id=original + "-" + digest(changes)[:12], derived_from=original, overrides=copy.deepcopy(changes))
            s["meta"]["title"] += " — изменённый вариант"
        validate(s)
    except (ValueError, TypeError, KeyError, OverflowError) as exc:
        raise InputError(f"Некорректный сценарий: {model_error(exc)}") from exc
    return s


def _planner(algorithm, goal, parameters=None):
    if not isinstance(algorithm, str) or not isinstance(goal, str) or (parameters is not None and not isinstance(parameters, dict)):
        raise InputError("Некорректные алгоритм, цель или настройки")
    try:
        return make_planner(algorithm, goal, **(parameters or {}))
    except (ValueError, TypeError) as exc:
        raise InputError(str(exc)) from exc


def _info(s):
    from .analysis import impossibility
    result = {"id": s["meta"]["id"], "title": s["meta"]["title"],
        "satellites": len(s["satellites"]), "steps": s["time"]["steps"],
        "step_s": s["time"]["step_s"], "jobs": len(s["jobs"]),
        "jobs_by_priority": {str(p): sum(j["priority"] == p for j in s["jobs"]) for p in (1, 2, 3)},
        "jobs_by_kind": {k: sum(j["kind"] == k for j in s["jobs"]) for k in ("relay", "downlink")},
        "provably_infeasible_jobs": sum(impossibility(s, j) is not None for j in s["jobs"])}
    for key in ("derived_from", "overrides"):
        if key in s["meta"]:
            result[key] = copy.deepcopy(s["meta"][key])
    return result


def list_scenarios():
    return [_info(_builtin(p.stem)) for p in sorted((ROOT / "data").glob("*.json"))]


def inspect_scenario(source):
    return _info(_source(source))


def create_run(source, goal, algorithm, parameters=None):
    s = _source(source)
    planner = _planner(algorithm, goal, parameters)
    return _signed({"schema": "sozvezdie-run-1", "id": uuid4().hex, "scenario": copy.deepcopy(source),
        "scenario_hash": digest(s), "run_metadata": {**planner.metadata(), "goal_history": [{"step": 0, "goal": goal}]},
        "events": [], "rejected_events": [], "commands": [], "steps_executed": 0,
        "planner_state": planner.to_state(), "notes": {}})


def _restore(record):
    try:
        if not isinstance(record, dict) or record.get("schema") != "sozvezdie-run-1":
            raise ValueError("Неверная схема записи запуска")
        # id и run_metadata.parent — метки браузера, в подпись не входят (сравнение проверяет повтор
        # префикса, а не метки), поэтому формат проверяем отдельно: id попадает в имя файла выгрузки.
        if not isinstance(record["id"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", record["id"]):
            raise ValueError("Некорректный идентификатор запуска: допустимы латиница, цифры, «-» и «_», до 64 знаков")
        if not hmac.compare_digest(str(record.get("signature", "")), _signature(record)):
            raise ValueError("Подпись записи не совпадает: запись изменена вне сервиса или подписана другим ключом сервера — смена будет пересчитана")
        s = _source(record["scenario"])
        if digest(s) != record["scenario_hash"]:
            raise ValueError("Исходный сценарий изменился: хеш не совпадает")
        meta = record["run_metadata"]
        planner = _planner(meta["algorithm"], meta["goal"], meta["parameters"])
        if meta["version"] != planner.version:
            raise ValueError("Версия планировщика изменилась; начните новый расчёт")
        history = meta["goal_history"]
        if not isinstance(history, list) or not history or history[0].get("step") != 0:
            raise ValueError("Некорректная история целей")
        previous = -1
        for item in history:
            if (not isinstance(item, dict) or type(item.get("step")) is not int
                    or not previous <= item["step"] <= record["steps_executed"]
                    or item.get("goal") not in ("priority", "revenue")):
                raise ValueError("Некорректная история целей")
            previous = item["step"]
        if history[-1]["goal"] != meta["goal"]:
            raise ValueError("Текущая цель расходится с историей")
        if not isinstance(record["rejected_events"], list) or not isinstance(record["notes"], dict):
            raise ValueError("Некорректный журнал запуска")
        parent = meta.get("parent")
        if parent is not None and (not isinstance(parent, dict) or not isinstance(parent.get("run_id"), str)
                or type(parent.get("fork_step")) is not int or not 0 <= parent["fork_step"] <= record["steps_executed"]):
            raise ValueError("Некорректная запись о родительской ветви")
        for key, notes in record["notes"].items():
            if (not isinstance(key, str) or not key.isdigit() or not isinstance(notes, dict)
                    or any(not isinstance(sid, str) or not isinstance(note, str) for sid, note in notes.items())):
                raise ValueError("Некорректные пояснения планировщика")
        planner.from_state(record["planner_state"])
        session = replay_episode(s, record["events"], record["commands"], record["steps_executed"])
        session.run_metadata = copy.deepcopy(meta)
        return session, planner
    except (ValueError, TypeError, KeyError, OverflowError, AttributeError) as exc:
        raise InputError(f"Некорректная запись запуска: {model_error(exc)}") from exc


def _pack(record, session, planner):
    result = copy.deepcopy(record)
    result.update(commands=copy.deepcopy(session.commands), events=copy.deepcopy(session.events),
                  steps_executed=session.env.k, planner_state=planner.to_state())
    result["run_metadata"].update(planner.metadata())
    return _signed(result)


def advance(record, until_step, budget_s=240):
    start = time.monotonic()
    session, planner = _restore(record)
    if type(until_step) is not int or not session.env.k <= until_step <= session.env.s["time"]["steps"]:
        raise InputError("Целевой шаг должен быть между текущим шагом и концом смены")
    if isinstance(budget_s, bool) or not isinstance(budget_s, (int, float)) or not math.isfinite(budget_s) or budget_s <= 0:
        raise InputError("Бюджет времени должен быть конечным положительным числом")
    result = copy.deepcopy(record)
    first = session.env.k
    while session.env.k < until_step:
        if session.env.k > first and time.monotonic() - start >= budget_s:
            break
        step = session.env.k
        session.advance(planner.decide(session))
        result["notes"][str(step)] = copy.deepcopy(planner.last_notes)
    return _pack(result, session, planner)


def apply_event(record, event):
    session, planner = _restore(record)
    result = copy.deepcopy(record)
    try:
        session.apply_event(event)
    except (ValueError, KeyError, TypeError) as exc:
        message = f"Сообщение отклонено: {model_error(exc)}"
        result["rejected_events"].append({"received_at_step": session.env.k,
            "payload": copy.deepcopy(event), "error": message})
        return _signed(result), message
    return _pack(result, session, planner), None


def set_goal(record, goal):
    session, planner = _restore(record)
    if goal not in ("priority", "revenue"):
        raise InputError("Неизвестная цель управления")
    result = copy.deepcopy(record)
    if goal != planner.goal:
        planner.set_goal(goal)
        result["run_metadata"]["goal_history"].append({"step": session.env.k, "goal": goal})
    return _pack(result, session, planner)


def fork(record, goal=None, algorithm=None):
    session, planner = _restore(record)
    goal = planner.goal if goal is None else goal
    algorithm = planner.name if algorithm is None else algorithm
    result = set_goal(record, goal) if goal != planner.goal else copy.deepcopy(record)
    if algorithm != planner.name:
        planner = _planner(algorithm, goal)
    else:
        planner.set_goal(goal)
    result["id"] = uuid4().hex
    result["run_metadata"]["parent"] = {"run_id": record["id"], "fork_step": session.env.k}
    return _pack(result, session, planner)


def _view(record, session, planner):
    summary = session.summary()
    due, total = summary["critical_jobs_due"], session.env.k * len(session.env.sats)
    result = {"id": record["id"], "scenario_id": session.initial_scenario["meta"]["id"],
        "status": "finished" if session.env.k == session.env.s["time"]["steps"] else "paused" if session.env.k else "ready",
        "step": session.env.k, "steps_total": session.env.s["time"]["steps"], "goal": planner.goal,
        "goal_history": copy.deepcopy(record["run_metadata"]["goal_history"]),
        "algorithm": {"name": planner.name, "version": planner.version, "parameters": copy.deepcopy(planner.params)},
        "summary": summary, "kpi": {
            "p3_on_time_share": summary["critical_jobs_completed_on_time"] / due if due else None,
            "utilization": sum(r["executed"] == "job" for r in session.env.trace) / total if total else None,
            "revenue_lost_in_missed_usd": round(sum(j["value_usd"] for j in session.env.jobs.values()
                if j["deadline_step"] <= session.env.k and j["completed_step"] is None), 6)},
        "events": copy.deepcopy(session.events), "rejected_events": copy.deepcopy(record["rejected_events"])}
    if "parent" in record["run_metadata"]:
        result["parent"] = copy.deepcopy(record["run_metadata"]["parent"])
    return result


def view(record):
    session, planner = _restore(record)
    return _view(record, session, planner)


def jobs(record, status=None, priority=None):
    from .analysis import job_views
    if status is not None and status not in ("waiting", "open", "in_progress", "completed", "missed"):
        raise InputError("Неизвестный статус задания")
    if priority is not None and (type(priority) is not int or priority not in (1, 2, 3)):
        raise InputError("Приоритет должен быть 1, 2 или 3")
    session, _ = _restore(record)
    return [j for j in job_views(session) if (status is None or j["status"] == status)
            and (priority is None or j["priority"] == priority)]


def trace(record, step_from, step_to, satellite_id=None):
    session, _ = _restore(record)
    if type(step_from) is not int or type(step_to) is not int or not 0 <= step_from <= step_to:
        raise InputError("Некорректный диапазон шагов")
    if satellite_id is not None and satellite_id not in session.env.sats:
        raise NotFound("Аппарат не найден")
    rows = []
    for original in session.env.trace:
        if step_from <= original["step"] < step_to and (satellite_id is None or original["satellite_id"] == satellite_id):
            row = copy.deepcopy(original)
            row["soc_after_pct"] = 100 * row["energy_after_wh"] / session.env.sats[row["satellite_id"]]["capacity_wh"]
            row["planner_note"] = record["notes"].get(str(row["step"]), {}).get(row["satellite_id"], "")
            rows.append(row)
    return rows


def timeline(record):
    session, _ = _restore(record)
    ids = sorted(session.env.sats)
    positions = {sid: i for i, sid in enumerate(ids)}
    result = {"satellites": ids, "steps_total": session.env.s["time"]["steps"],
        "steps_executed": session.env.k, "action": ["" for _ in ids],
        "job": [[] for _ in ids], "soc": [[] for _ in ids], "temp": [[] for _ in ids],
        "dark": ["".join("1" if w == 0 else "0" for w in session.env.s["environment"][sid]["solar_w"]) for sid in ids],
        "reasons": {}}
    for row in session.env.trace:
        sid = row["satellite_id"]
        i = positions[sid]
        rejected = row["reason"] not in ("accepted", "idle")
        jid = row["requested"].get("job_id")
        code = "x" if rejected else "c" if row["executed"] == "calibrate" else "."
        if row["executed"] == "job":
            code = "r" if session.env.jobs[jid]["kind"] == "relay" else "d"
        result["action"][i] += code
        result["job"][i].append(jid if code in ("r", "d", "x") else None)
        result["soc"][i].append(round(100 * row["energy_after_wh"] / session.env.sats[sid]["capacity_wh"], 1))
        result["temp"][i].append(round(row["temp_after_c"], 1))
        if rejected:
            result["reasons"][f"{sid}|{row['step']}"] = row["reason"]
    return result


def explain(record, job_id=None, satellite_id=None, step=None):
    from .analysis import explanation
    session, _ = _restore(record)
    return explanation(session, {int(k): v for k, v in record["notes"].items()}, job_id, satellite_id, step)


def compare(record_a, record_b):
    from .comparison import compare_records
    a, pa = _restore(record_a)
    b, pb = _restore(record_b)
    return compare_records(record_a, record_b, a, b, _view(record_a, a, pa), _view(record_b, b, pb))


def export(record, include_trace=False):
    session, _ = _restore(record)
    result = session.result()
    if not include_trace:
        result.pop("trace")
    return result


def replay(result):
    try:
        if not isinstance(result, dict) or result.get("schema_version") != RESULT_SCHEMA:
            raise ValueError("Неверная схема результата")
        session = replay_episode(result["initial_scenario"], result["events"], result["commands"], result["steps_executed"])
        actual, diff = session.summary(), {}
        if result.get("summary") != actual:
            diff["summary"] = {"saved": result.get("summary"), "actual": actual}
        if "initial_scenario_hash" in result and result["initial_scenario_hash"] != digest(result["initial_scenario"]):
            diff["initial_scenario_hash"] = "Хеш сценария не совпадает"
        if "trace" in result and result["trace"] != session.env.trace:
            diff["trace"] = "Журнал не совпадает"
        return {"match": not diff, "summary": actual, "diff": diff}
    except (ValueError, KeyError, TypeError, OverflowError) as exc:
        raise InputError(f"Не удалось воспроизвести расчёт: {model_error(exc)}") from exc


# Публичные имена для функций О7 (core/features.py): восстановление смены и чтение сценария.
restore = _restore
source = _source
