"""ИИ-помощник оператора: только пересказ фактов ядра и разбор текста в черновик сообщения.

Правила:
  * ИИ ничего не считает и не решает. Факты собирает ядро (view, jobs, explain, trace).
  * Ответ проверяется: каждый идентификатор и каждое число из ответа должны встречаться в фактах.
    Не сошлось — показывается шаблонный ответ без ИИ.
  * Черновик сообщения не применяется: его подтверждает оператор, проверяет модель организаторов.
  * Без ключа ANTHROPIC_API_KEY (или при ошибке API) всё работает на шаблонах.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

from core import service

MODEL = os.environ.get("SOZVEZDIE_AI_MODEL", "claude-opus-5")
FALLBACK_BETA = "server-side-fallback-2026-07-01"
ID_RE = re.compile(r"\b(?:S\d{2}|JOB-\d{3,5}|[A-Z]{2,5}-[A-Z]-\d{2}|E-[\w-]+)\b")
NUM_RE = re.compile(r"(?<![\w.])\d+(?:[.,]\d+)?(?![\w])")
TIME_RE = re.compile(r"\b(\d{1,2}):(\d{2})\b")

_client = None


def enabled() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _anthropic():
    global _client
    if _client is None:
        import anthropic
        # Лимит Vercel — 300 с на запрос; ответ помощника должен уложиться с запасом.
        _client = anthropic.Anthropic(timeout=90.0, max_retries=1)
    return _client


def _call(system: str, user: str, schema: dict, effort: str) -> dict | None:
    """Один запрос со строгой JSON-схемой ответа. None — если ИИ недоступен или отказал."""
    import anthropic
    try:
        response = _anthropic().beta.messages.create(
            model=MODEL,
            max_tokens=4000,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
            system=system,
            messages=[{"role": "user", "content": user}],
        )
    except (anthropic.APIConnectionError, anthropic.RateLimitError, anthropic.APIStatusError):
        return None
    if response.stop_reason in ("refusal", "max_tokens"):
        return None
    text = next((b.text for b in response.content if b.type == "text"), None)
    try:
        return json.loads(text) if text else None
    except json.JSONDecodeError:
        return None


# ---------------------------------------------------------------- «Спросить смену»
def _step_of(hh: str, mm: str) -> int:
    return (int(hh) * 60 + int(mm)) // 5


def gather_facts(run: dict, question: str) -> dict:
    """Факты для ответа: сводка смены, упомянутые задания/аппараты и сорванные задания."""
    view = service.view(run)
    jobs = service.jobs(run)
    by_id = {j["id"]: j for j in jobs}
    ids = set(ID_RE.findall(question.upper()))
    steps = [_step_of(h, m) for h, m in TIME_RE.findall(question)]
    steps += [int(x) for x in re.findall(r"шаг\w*\s+(\d{1,3})", question.lower())]
    facts: dict[str, Any] = {
        "смена": {"шаг": view["step"], "всего_шагов": view["steps_total"], "цель": view["goal"],
                  "алгоритм": view["algorithm"]["name"], "сводка": view["summary"], "kpi": view["kpi"]},
        "сообщения": view["events"],
        "задания": {}, "аппараты": {},
    }
    for jid in sorted(i for i in ids if i in by_id):
        facts["задания"][jid] = {"задание": by_id[jid], "объяснение": service.explain(run, job_id=jid)}
    for sid in sorted(i for i in ids if re.fullmatch(r"S\d{2}", i)):
        at = [k for k in steps if 0 <= k < view["step"]] or [max(view["step"] - 1, 0)]
        lo, hi = max(min(at) - 3, 0), min(max(at) + 4, view["step"])
        facts["аппараты"][sid] = {
            "журнал": service.trace(run, lo, hi, sid),
            "объяснение": service.explain(run, satellite_id=sid, step=at[0]) if view["step"] else None,
        }
    if not facts["задания"] and not facts["аппараты"]:
        missed = [j for j in jobs if j["status"] == "missed"]
        facts["сорванные_задания"] = missed[:40]
        facts["сорванных_всего"] = len(missed)
    return facts


ASK_SYSTEM = """Ты помогаешь оператору наземной смены спутниковой группировки разобраться в уже выполненной смене.
Отвечай по-русски, кратко (2–6 предложений), только на основе JSON-фактов из сообщения пользователя.
Каждое утверждение подкрепляй ссылкой в квадратных скобках: [S01 · шаг 82] или [JOB-0002].
Время смены: шаг k — это k×5 минут от начала (шаг 72 = 06:00).
Если в фактах нет ответа — так и скажи и укажи, каких сведений не хватает. Не придумывай чисел.
Различай «ограничение задачи» (доказано: нет контактов, аппарат недоступен) и «решение алгоритма»
(аппарат был занят другим, заряд ушёл на другое): это разные причины."""

ASK_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "answered_from_facts": {"type": "boolean"},
    },
    "required": ["answer", "answered_from_facts"],
    "additionalProperties": False,
}


def _grounded(answer: str, facts: dict) -> bool:
    """Все идентификаторы и числа ответа есть в фактах (число шага можно дать как время ЧЧ:ММ)."""
    blob = json.dumps(facts, ensure_ascii=False)
    known = {n.replace(",", ".").rstrip("0").rstrip(".") if "." in n.replace(",", ".") else n
             for n in NUM_RE.findall(blob)}
    for token in ID_RE.findall(answer):
        if token not in blob:
            return False
    times = {f"{int(h):02d}:{m}" for h, m in TIME_RE.findall(answer)}
    for num in NUM_RE.findall(answer):
        value = num.replace(",", ".")
        short = value.rstrip("0").rstrip(".") if "." in value else value
        if short in known or any(t.startswith(num) or t.endswith(num) for t in times):
            continue
        if len(value.rstrip("0").rstrip(".")) <= 1:   # «1 аппарат», «2 канала» — служебные малые числа
            continue
        return False
    return True


def _template(facts: dict) -> str:
    parts = []
    for jid, item in facts["задания"].items():
        e = item["объяснение"]
        parts.append(f"{jid}: {e['consequence']}")
    for sid, item in facts["аппараты"].items():
        e = item["объяснение"]
        if e:
            parts.append(f"{sid}: {e['consequence']}")
    if not parts:
        s = facts["смена"]["сводка"]
        parts.append(f"Выполнено {s['jobs_completed']} из {s['jobs_total']} заданий, приоритет 3 в срок — "
                     f"{s['critical_jobs_completed_on_time']} из {s['critical_jobs_due']}, выручка ${s['revenue_usd']}. "
                     f"Уточните вопрос: назовите задание (JOB-…) или аппарат (S…) и время.")
    return " ".join(parts)


def ask(run: dict, question: str) -> dict:
    question = question.strip()[:500]
    facts = gather_facts(run, question)
    result = {"answer": _template(facts), "source": "template", "facts": facts}
    if not enabled() or not question:
        return result
    reply = _call(ASK_SYSTEM, f"Вопрос оператора: {question}\n\nФакты (JSON):\n"
                  + json.dumps(facts, ensure_ascii=False), ASK_SCHEMA, effort="medium")
    if reply and _grounded(reply["answer"], facts):
        result.update(answer=reply["answer"], source="ai")
    elif reply:
        result["source"] = "template_after_check"   # ИИ ответил, но проверка фактов не пройдена
    return result


# ---------------------------------------------------------------- сообщение текстом
EVENT_SYSTEM = """Ты переводишь сообщение оператора спутниковой группировки в черновик события.
Типы: satellite_outage — аппараты недоступны для заданий и калибровки до конца интервала;
close_downlink — отменены сеансы передачи на Землю для аппаратов до конца интервала;
unsupported — всё остальное (новые задания вводятся JSON-файлом, не текстом).
Время смены: шаг k = k×5 минут от 00:00; конец интервала end_step — шаг, до которого (не включая)
действует ограничение. «До 14:30» → end_step = 174. «На час» → текущий шаг + 12.
Используй только идентификаторы аппаратов из списка. Если чего-то не хватает — тип unsupported и вопрос в clarification."""

EVENT_SCHEMA = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["satellite_outage", "close_downlink", "unsupported"]},
        "satellite_ids": {"type": "array", "items": {"type": "string"}},
        "end_step": {"type": "integer"},
        "clarification": {"type": "string"},
    },
    "required": ["type", "satellite_ids", "end_step", "clarification"],
    "additionalProperties": False,
}


def draft_event(run: dict, text: str) -> dict:
    """Черновик события из текста. Не применяется — только показывается оператору."""
    view = service.view(run)
    sats = sorted(service.timeline(run)["satellites"])
    k, total = view["step"], view["steps_total"]
    if not enabled():
        return {"event": None, "error": "ИИ не подключён на сервере — заполните форму или вставьте JSON."}
    reply = _call(EVENT_SYSTEM, json.dumps({"сообщение": text.strip()[:500], "текущий_шаг": k,
                                            "всего_шагов": total, "аппараты": sats}, ensure_ascii=False),
                  EVENT_SCHEMA, effort="low")
    if reply is None:
        return {"event": None, "error": "ИИ сейчас недоступен — заполните форму или вставьте JSON."}
    if reply["type"] == "unsupported":
        return {"event": None, "error": reply["clarification"] or "Не удалось понять сообщение."}
    bad = [s for s in reply["satellite_ids"] if s not in sats]
    if bad or not reply["satellite_ids"]:
        return {"event": None, "error": f"Неизвестные аппараты: {', '.join(bad)}" if bad else "Не указаны аппараты."}
    if not k < reply["end_step"] <= total:
        return {"event": None, "error": f"Конец интервала должен быть после текущего шага {k} и не позже {total}."}
    used = {e["id"] for e in view["events"]} | {r.get("payload", {}).get("id") for r in view["rejected_events"]
                                                if isinstance(r.get("payload"), dict)}
    n = len(used) + 1
    while f"E-{n}" in used:
        n += 1
    event = {"id": f"E-{n}", "at_step": k, "type": reply["type"],
             "satellite_ids": sorted(set(reply["satellite_ids"])), "end_step": reply["end_step"]}
    return {"event": event, "error": None, "note": reply["clarification"]}
