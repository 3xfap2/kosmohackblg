"""HTTP-слой поверх core.service — без состояния (Vercel Functions).

Сервер ничего не хранит: запись запуска (RunRecord) приходит в каждом запросе и возвращается
обновлённой. Здесь нет расчётов — только маршруты и перевод ошибок ядра в понятные ответы.
"""
from __future__ import annotations

import os
from typing import Any, Literal

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api import ai
from core import service
from core.errors import InputError, NotFound

# Запас до лимита Vercel Hobby (300 с на запрос): остаток доделывает следующий вызов клиента.
BUDGET_S = float(os.environ.get("SOZVEZDIE_STEP_BUDGET_S", "240"))

app = FastAPI(title="Созвездие API", version="1.0")

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


@app.get("/api/health")
def health():
    return {"ok": True}
