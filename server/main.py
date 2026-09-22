"""HTTP-слой поверх core.service — без состояния (Vercel Functions).

Сервер ничего не хранит: запись запуска (RunRecord) приходит в каждом запросе и возвращается
обновлённой. Здесь нет расчётов — только маршруты и перевод ошибок ядра в понятные ответы.
"""
from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Literal

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from server import ai
from core import features, service
from core.errors import InputError, NotFound

# Запас до лимита Vercel Hobby (300 с на запрос): остаток доделывает следующий вызов клиента.
def _budget() -> float:
    """Бюджет запроса расчёта из окружения; некорректное значение — не падение импорта, а значение по умолчанию."""
    try:
        value = float(os.environ.get("SOZVEZDIE_STEP_BUDGET_S", "240"))
    except ValueError:
        return 240.0
    return value if 1 <= value <= 290 else 240.0


BUDGET_S = _budget()

app = FastAPI(title="Созвездие API", version="1.0")

# Защита публичного развёртывания: размер записи и число одновременных тяжёлых исследований.
MAX_BODY_BYTES = 8 * 1024 * 1024                       # запись P04 со своим сценарием — около 3 МБ
HEAVY = threading.BoundedSemaphore(2)                  # what-if, frontier, stress, турнир — полные смены


@app.middleware("http")
async def limit_body(request, call_next):
    size = request.headers.get("content-length", "0")
    if not size.isdigit() or int(size) > MAX_BODY_BYTES:
        return JSONResponse({"detail": "Запрос слишком большой: запись смены больше 8 МБ"}, status_code=413)
    return await call_next(request)


def heavy(fn, *args):
    if not HEAVY.acquire(blocking=False):
        raise HTTPException(429, "Сервер занят другим исследованием смены — повторите через минуту")
    try:
        return call(fn, *args)
    finally:
        HEAVY.release()

Goal = Literal["priority", "revenue"]
Algorithm = Literal["horizon-cpsat", "goal-greedy", "edf-baseline"]
Record = dict[str, Any]


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except InputError as exc:
        raise HTTPException(422, str(exc)) from exc
    except NotFound as exc:
        raise HTTPException(404, str(exc)) from exc


def with_view(run: Record) -> dict:
    return {"run": run, "view": service.view(run)}


# ------------------------------------------------------------------ модели запросов
class Inspect(BaseModel):
    source: dict[str, Any]


class Create(BaseModel):
    source: dict[str, Any]
    goal: Goal = "priority"
    algorithm: Algorithm = "horizon-cpsat"
    parameters: dict[str, Any] | None = None


class RunOnly(BaseModel):
    run: Record


class Advance(RunOnly):
    until_step: int = Field(..., ge=0)


class Event(RunOnly):
    event: Any


class GoalChange(RunOnly):
    goal: Goal


class Fork(RunOnly):
    goal: Goal | None = None
    algorithm: Algorithm | None = None


class Jobs(RunOnly):
    status: str | None = None
    priority: int | None = None


class Trace(RunOnly):
    step_from: int = Field(0, ge=0)
    step_to: int = Field(..., ge=0)
    satellite_id: str | None = None


class Explain(RunOnly):
    job_id: str | None = None
    satellite_id: str | None = None
    step: int | None = None


class Compare(BaseModel):
    a: Record
    b: Record


class Export(RunOnly):
    include_trace: bool = False


# ------------------------------------------------------------------ сценарии
@app.get("/api/scenarios")
def scenarios():
    return service.list_scenarios()


@app.post("/api/scenarios/inspect")
def inspect(body: Inspect):
    return call(service.inspect_scenario, body.source)


# ------------------------------------------------------------------ запуски
@app.post("/api/runs/create")
def create(body: Create):
    return with_view(call(service.create_run, body.source, body.goal, body.algorithm, body.parameters))


@app.post("/api/runs/advance")
def advance(body: Advance):
    return with_view(call(service.advance, body.run, body.until_step, BUDGET_S))


@app.post("/api/runs/event")
def event(body: Event):
    run, error = call(service.apply_event, body.run, body.event)
    return {**with_view(run), "error": error}


@app.post("/api/runs/goal")
def goal(body: GoalChange):
    return with_view(call(service.set_goal, body.run, body.goal))


@app.post("/api/runs/fork")
def fork(body: Fork):
    return with_view(call(service.fork, body.run, body.goal, body.algorithm))


@app.post("/api/runs/view")
def view(body: RunOnly):
    return call(service.view, body.run)


@app.post("/api/runs/jobs")
def jobs(body: Jobs):
    return call(service.jobs, body.run, body.status, body.priority)


@app.post("/api/runs/trace")
def trace(body: Trace):
    return call(service.trace, body.run, body.step_from, body.step_to, body.satellite_id)


@app.post("/api/runs/timeline")
def timeline(body: RunOnly):
    return call(service.timeline, body.run)


@app.post("/api/runs/explain")
def explain(body: Explain):
    return call(service.explain, body.run, body.job_id, body.satellite_id, body.step)


@app.post("/api/compare")
def compare(body: Compare):
    return call(service.compare, body.a, body.b)


@app.post("/api/runs/export")
def export(body: Export):
    data = call(service.export, body.run, body.include_trace)
    name = f"sozvezdie_{body.run.get('id', 'run')}.json"
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/runs/verify")
def verify(body: RunOnly):
    """Проверка целиком на сервере: выгрузка → повтор официальной моделью. Без круга через браузер:
    JavaScript превращает 125.0 в 125, и хеш исходного сценария перестал бы совпадать."""
    return call(service.replay, call(service.export, body.run, False))


@app.post("/api/replay")
def replay(result: dict = Body(...)):
    return call(service.replay, result)


class Ask(RunOnly):
    question: str = Field(..., max_length=500)


class Draft(RunOnly):
    text: str = Field(..., max_length=500)


@app.get("/api/ai/status")
def ai_status():
    return {"enabled": ai.enabled(), "model": ai.MODEL if ai.enabled() else None}


@app.post("/api/ai/ask")
def ai_ask(body: Ask):
    return call(ai.ask, body.run, body.question)


@app.post("/api/ai/event")
def ai_event(body: Draft):
    return call(ai.draft_event, body.run, body.text)


# ------------------------------------------------------------------ функции О7 (docs/PROPOSAL_O7.md)
class Impact(RunOnly):
    event: Any
    horizon: int = Field(48, ge=6, le=96)


class JobQuery(RunOnly):
    job_id: str


class SatQuery(RunOnly):
    satellite_id: str


class Stress(RunOnly):
    runs: int = Field(12, ge=1, le=30)


@app.post("/api/features/impact")
def f_impact(body: Impact):
    return call(features.event_impact, body.run, body.event, body.horizon)


@app.post("/api/features/forecast")
def f_forecast(body: RunOnly):
    return call(features.forecast, body.run)


@app.post("/api/features/why-not")
def f_why_not(body: JobQuery):
    return call(features.why_not, body.run, body.job_id)


@app.post("/api/features/what-if")
def f_what_if(body: RunOnly):
    return heavy(features.what_if, body.run)


@app.post("/api/features/frontier")
def f_frontier(body: RunOnly):
    return heavy(features.frontier, body.run)


@app.post("/api/features/stress")
def f_stress(body: Stress):
    return heavy(features.stress_test, body.run, body.runs)


@app.post("/api/features/tournament")
def f_tournament(body: RunOnly):
    return heavy(features.tournament, body.run)


@app.post("/api/features/link")
def f_link(body: RunOnly):
    return call(features.link_continuity, body.run)


@app.post("/api/features/passport")
def f_passport(body: SatQuery):
    return call(features.passport, body.run, body.satellite_id)


@app.post("/api/features/report")
def f_report(body: RunOnly):
    return call(features.shift_report, body.run)


DEMO_EVENTS = Path(__file__).resolve().parent.parent / "examples" / "events_demo.json"


RESULTS = Path(__file__).resolve().parent.parent / "results" / "summary.json"


@app.get("/api/proof")
def proof():
    """Числа для лендинга — только из results/summary.json (генератор experiments/run.py).
    Здесь нет расчёта: выбор строк и перекладка полей сводки."""
    import json
    if not RESULTS.exists():
        return {"available": False, "rows": [], "events": []}
    runs = json.loads(RESULTS.read_text(encoding="utf-8"))["runs"]

    def pick(key):
        r = runs.get(key)
        if not r:
            return None
        m = r["summary"]
        return {"p3_done": m["critical_jobs_completed_on_time"], "p3_due": m["critical_jobs_due"],
                "jobs_done": m["jobs_completed"], "jobs_total": m["jobs_total"], "revenue_usd": m["revenue_usd"],
                "blocked": m["blocked_command_count"], "min_soc_pct": m["minimum_soc_pct"]}

    rows = []
    for scenario in ("P02_shift", "P03_energy", "P04_demand"):
        for goal in ("priority", "revenue"):
            row = {"scenario": scenario, "goal": goal,
                   **{alg: pick(f"{scenario}__{alg}__{goal}") for alg in ("edf-baseline", "goal-greedy", "horizon-cpsat")}}
            if row["edf-baseline"]:
                rows.append(row)
    events = [{"goal": goal, "adaptive": pick(f"P02_events__adaptive__{goal}"), "frozen": pick(f"P02_events__frozen__{goal}")}
              for goal in ("priority", "revenue") if runs.get(f"P02_events__adaptive__{goal}")]
    checks = [r for r in runs.values() if "replay_match" in r or "repeat_match" in r]
    return {"available": True, "source": "results/summary.json", "rows": rows, "events": events,
            "runs": len(runs), "replay_ok": sum(bool(r.get("replay_match")) for r in checks),
            "repeat_ok": sum(bool(r.get("repeat_match")) for r in checks)}


@app.get("/api/results")
def results():
    """Все прогоны генератора для страницы «Результаты»: итог модели, проверки повтором,
    статистика решателя и время. Только перекладка полей results/summary.json и results/timings.json."""
    import json
    if not RESULTS.exists():
        return {"available": False, "runs": []}
    runs = json.loads(RESULTS.read_text(encoding="utf-8"))["runs"]
    timings_file = RESULTS.parent / "timings.json"
    timings = json.loads(timings_file.read_text(encoding="utf-8")) if timings_file.exists() else {}
    out = []
    for key, r in runs.items():
        m = r["summary"]
        out.append({"key": key, "scenario": r["scenario_id"], "algorithm": r["algorithm"], "goal": r["goal"],
                    "p3_done": m["critical_jobs_completed_on_time"], "p3_due": m["critical_jobs_due"],
                    "jobs_done": m["jobs_completed"], "jobs_total": m["jobs_total"], "revenue_usd": m["revenue_usd"],
                    "blocked": m["blocked_command_count"], "min_soc_pct": m["minimum_soc_pct"],
                    "below_reserve": m["below_reserve_satellite_steps"],
                    "mean_terminal_soc_pct": round(sum(m["terminal_soc_pct"].values()) / len(m["terminal_soc_pct"]), 6),
                    "missed_work_steps": m["work_steps_in_missed_jobs"],
                    "replay_match": r.get("replay_match"), "repeat_match": r.get("repeat_match"),
                    "new_jobs_total": r.get("new_jobs_total"), "new_jobs_completed": r.get("new_jobs_completed"),
                    "plan_rejections": sum((r.get("plan_rejections") or {}).values()),
                    "missed": m["jobs_due_missed"],
                    "solves": r["solves"], "cpsat_selected": r["cpsat_selected_solves"],
                    "guard": r["baseline_guard_solves"], "fallback": r["fallback_solves"],
                    "seconds": timings.get(key)})
    return {"available": True, "source": "results/summary.json", "runs": out}


@app.get("/api/extended")
def extended():
    """Расширенная модель (ориентация, светотень, связь): results/extended_summary.json
    от experiments/extended.py. Без расчёта — только чтение файла."""
    import json
    path = RESULTS.parent / "extended_summary.json"
    if not path.exists():
        return {"available": False}
    return {"available": True, "source": "results/extended_summary.json", **json.loads(path.read_text(encoding="utf-8"))}


DEMO_STOP = 144  # 12:00: два сообщения уже приняты, два следующих оператор отправляет сам


@app.post("/api/demo")
def demo():
    """Демо-смена: P02 и открытый пример сообщений организаторов.

    Смена останавливается в 12:00: сообщения до этого шага уже приняты, остальные возвращаются
    как подсказки — оператор отправляет их сам, продолжает расчёт, создаёт ветви.
    Здесь только порядок вызовов ядра. Алгоритм — эвристика по цели (расчёт за секунды).
    """
    import json
    events = json.loads(DEMO_EVENTS.read_text(encoding="utf-8"))["events"]
    run = call(service.create_run, {"ref": "P02_shift"}, "priority", "goal-greedy", None)
    for event in [e for e in events if e["at_step"] < DEMO_STOP]:
        while run["steps_executed"] < event["at_step"]:
            run = call(service.advance, run, event["at_step"], BUDGET_S)
        run, error = call(service.apply_event, run, event)
        if error:
            raise HTTPException(500, f"Демо-сообщение {event['id']} отклонено: {error}")
    while run["steps_executed"] < DEMO_STOP:
        run = call(service.advance, run, DEMO_STOP, BUDGET_S)
    return {**with_view(run), "suggested_events": [e for e in events if e["at_step"] >= DEMO_STOP]}


@app.get("/api/health")
def health():
    return {"ok": True}


# ------------------------------------------------------------------ интерфейс
# Собранный web/dist: ассеты — со CDN (Vercel продвигает mount), остальные пути — index.html
# (маршрутизация на стороне браузера). Локально без сборки этот блок не активен.
WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"
if (WEB_DIST / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Неизвестный адрес API")
        file = (WEB_DIST / path).resolve()
        if path and file.is_file() and WEB_DIST in file.parents:
            return FileResponse(file)
        return FileResponse(WEB_DIST / "index.html")
