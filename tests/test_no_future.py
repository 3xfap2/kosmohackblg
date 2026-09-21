"""Будущие сообщения не используются до их получения (Т3).

Повтор журнала моделью этого не доказывает (replay_episode проверяет учёт, а не знание
наперёд), поэтому проверяем отдельно:
1. Сервис не принимает сообщение раньше его шага — узнать будущее через API нельзя.
2. Команды до получения каждого сообщения совпадают побитно с прогоном, в котором этого
   сообщения нет вовсе: решение до шага получения от сообщения не зависит.
"""
import json
from pathlib import Path

from core import service
from model.operations import digest

ROOT = Path(__file__).resolve().parents[1]
EVENTS = json.loads((ROOT / "examples" / "events_demo.json").read_text(encoding="utf-8"))
EVENTS = EVENTS["events"] if isinstance(EVENTS, dict) else EVENTS


def shift(events, until):
    rec = service.create_run({"ref": "P02_shift"}, "priority", "goal-greedy")
    for e in sorted(events, key=lambda e: e["at_step"]):
        rec, err = service.apply_event(service.advance(rec, e["at_step"]), e)
        assert err is None, err
    return service.advance(rec, until)


def before(record, step):
    return digest([c for c in record["commands"] if c["step"] < step])


def test_future_event_is_rejected_by_service():
    rec = service.create_run({"ref": "P02_shift"}, "priority", "goal-greedy")
    future = min(EVENTS, key=lambda e: e["at_step"])
    rec, err = service.apply_event(rec, future)
    assert err and rec["events"] == [] and rec["rejected_events"]


def test_commands_before_each_event_do_not_depend_on_it():
    ordered = sorted(EVENTS, key=lambda e: e["at_step"])
    last = ordered[-1]["at_step"] + 12
    full = shift(ordered, last)
    for i, e in enumerate(ordered):
        without = shift(ordered[:i], last)
        assert before(full, e["at_step"]) == before(without, e["at_step"]), e["id"]
    # После получения сообщения учитываются: без них смена идёт иначе.
    assert digest(full["commands"]) != digest(shift([], last)["commands"])
