"""HTTP-слой поверх core.service.

Здесь нет расчётов: только маршруты, фоновое исполнение долгих шагов, изоляция запусков
по клиенту (cookie) и перевод ошибок ядра в понятные ответы.
"""
from __future__ import annotations

import os
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Literal

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core import service
from core.errors import InputError, NotFound

COOKIE = "sz_client"
MAX_RUNS = int(os.environ.get("SOZVEZDIE_MAX_RUNS_PER_CLIENT", "20"))
WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"

app = FastAPI(title="Созвездие API", version="1.0")
_pool = ThreadPoolExecutor(max_workers=int(os.environ.get("SOZVEZDIE_WORKERS", "2")))
_lock = threading.Lock()
_owners: dict[str, set[str]] = {}          # клиент -> его запуски
_running: dict[str, dict[str, Any]] = {}   # запуск -> {"step", "target"} пока идёт расчёт
_failed: dict[str, str] = {}               # запуск -> текст ошибки последнего расчёта


# ------------------------------------------------------------------ клиент и доступ
def client_id(request: Request, response: Response) -> str:
    cid = request.cookies.get(COOKIE)
    if not cid:
        cid = uuid.uuid4().hex
        response.set_cookie(COOKIE, cid, httponly=True, samesite="lax", max_age=7 * 24 * 3600)
    return cid


def owned(run_id: str, cid: str) -> str:
    if run_id not in _owners.get(cid, set()):
        raise HTTPException(404, "Запуск не найден")
    return run_id


def register(cid: str, view: dict) -> dict:
    with _lock:
        runs = _owners.setdefault(cid, set())
        if len(runs) >= MAX_RUNS:
            raise HTTPException(429, f"Не больше {MAX_RUNS} запусков на пользователя — удалите старые")
        runs.add(view["id"])
    return view


def idle(run_id: str) -> None:
    if run_id in _running:
        raise HTTPException(409, "Идёт расчёт — дождитесь окончания или остановки")


def view(run_id: str) -> dict:
    v = service.get_run(run_id)
    if run_id in _running:
        v["status"] = "running"
        v["progress"] = dict(_running[run_id])
    elif run_id in _failed:
        v["status"] = "error"
        v["error"] = _failed[run_id]
    return v


def call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except InputError as exc:
        raise HTTPException(422, str(exc)) from exc
    except NotFound as exc:
        raise HTTPException(404, str(exc)) from exc


# ------------------------------------------------------------------ модели запросов
Goal = Literal["priority", "revenue"]
Algorithm = Literal["horizon-cpsat", "edf-baseline"]


class RunCreate(BaseModel):
    scenario_id: str
    goal: Goal = "priority"
    algorithm: Algorithm = "horizon-cpsat"
    parameters: dict[str, Any] | None = None


class Advance(BaseModel):
    until_step: int | None = Field(None, ge=0)
    steps: int | None = Field(None, ge=1)


class GoalChange(BaseModel):
    goal: Goal


class ForkRequest(BaseModel):
    goal: Goal | None = None
    algorithm: Algorithm | None = None


# ------------------------------------------------------------------ сценарии
@app.get("/api/scenarios")
def scenarios():
    return service.list_scenarios()


@app.post("/api/scenarios")
def upload_scenario(raw: dict = Body(...)):
    return call(service.add_scenario, raw)


@app.post("/api/scenarios/{scenario_id}/derive")
def derive(scenario_id: str, overrides: dict = Body(...)):
    return call(service.derive_scenario, scenario_id, overrides)


# ------------------------------------------------------------------ запуски
@app.post("/api/runs")
def create_run(body: RunCreate, cid: str = Depends(client_id)):
    v = call(service.create_run, body.scenario_id, body.goal, body.algorithm, body.parameters)
    return register(cid, v)


@app.get("/api/runs")
def my_runs(cid: str = Depends(client_id)):
    return [view(r) for r in sorted(_owners.get(cid, set()))]


@app.get("/api/runs/{run_id}")
def get_run(run_id: str, cid: str = Depends(client_id)):
    return view(owned(run_id, cid))


@app.post("/api/runs/{run_id}/advance")
def advance(run_id: str, body: Advance, cid: str = Depends(client_id)):
    owned(run_id, cid)
    with _lock:
        idle(run_id)
        current = service.get_run(run_id)
        if body.until_step is not None:
            target = body.until_step
        elif body.steps is not None:
            target = current["step"] + body.steps
        else:
            target = current["steps_total"]
        target = min(target, current["steps_total"])
        if target <= current["step"]:
            raise HTTPException(422, f"Смена уже на шаге {current['step']}; укажите шаг больше текущего")
        _running[run_id] = {"step": current["step"], "target": target}
        _failed.pop(run_id, None)

    def progress(step: int) -> None:
        _running[run_id]["step"] = step

    def job() -> None:
        try:
            service.advance(run_id, target, on_progress=progress)
        except Exception as exc:  # ошибка показывается в статусе запуска, а не теряется в потоке
            _failed[run_id] = f"Расчёт остановлен: {exc}"
        finally:
            _running.pop(run_id, None)

    _pool.submit(job)
    return view(run_id)


@app.post("/api/runs/{run_id}/events")
def post_event(run_id: str, event: Any = Body(...), cid: str = Depends(client_id)):
    idle(owned(run_id, cid))
    return call(service.apply_event, run_id, event)


@app.post("/api/runs/{run_id}/goal")
def set_goal(run_id: str, body: GoalChange, cid: str = Depends(client_id)):
    idle(owned(run_id, cid))
    return call(service.set_goal, run_id, body.goal)


@app.post("/api/runs/{run_id}/fork")
def fork(run_id: str, body: ForkRequest, cid: str = Depends(client_id)):
    idle(owned(run_id, cid))
    return register(cid, call(service.fork, run_id, body.goal, body.algorithm))


@app.get("/api/runs/{run_id}/jobs")
def jobs(run_id: str, status: str | None = None, priority: int | None = None,
         cid: str = Depends(client_id)):
    return call(service.jobs, owned(run_id, cid), status, priority)


@app.get("/api/runs/{run_id}/trace")
def trace(run_id: str, step_from: int = 0, step_to: int = 288, satellite_id: str | None = None,
          cid: str = Depends(client_id)):
    return call(service.trace, owned(run_id, cid), step_from, step_to, satellite_id)


@app.get("/api/runs/{run_id}/explain")
def explain(run_id: str, job_id: str | None = None, satellite_id: str | None = None,
            step: int | None = None, cid: str = Depends(client_id)):
    return call(service.explain, owned(run_id, cid), job_id, satellite_id, step)


@app.get("/api/compare")
def compare(a: str, b: str, cid: str = Depends(client_id)):
    return call(service.compare, owned(a, cid), owned(b, cid))


@app.get("/api/runs/{run_id}/export")
def export(run_id: str, cid: str = Depends(client_id)):
    idle(owned(run_id, cid))
    data = call(service.export, run_id)
    headers = {"Content-Disposition": f'attachment; filename="sozvezdie_{run_id}.json"'}
    from fastapi.responses import JSONResponse
    return JSONResponse(data, headers=headers)


@app.post("/api/replay")
def replay(result: dict = Body(...)):
    return call(service.replay, result)


@app.get("/api/health")
def health():
    return {"ok": True}


# ------------------------------------------------------------------ фронтенд
if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        file = WEB_DIST / path
        return FileResponse(file if path and file.is_file() else WEB_DIST / "index.html")
