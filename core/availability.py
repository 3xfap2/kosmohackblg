"""Известная недоступность аппарата: одна проверка для планировщиков, анализа потерь и функций."""


def unavailable(s, sid, t):
    """Аппарат sid недоступен на шаге t по периодам failures сценария (включая принятые сообщения)."""
    return any(f["satellite_id"] == sid and f["start_step"] <= t < f["end_step"] for f in s["failures"])
