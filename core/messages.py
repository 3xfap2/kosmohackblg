"""Русские сообщения интерфейса; машинные коды официального журнала не меняются."""
import re

_ERRORS = {
    "Event must be an object": "Сообщение должно быть объектом JSON",
    "Event id must be a new nonempty string": "Укажите непустой id, который ещё не использовался",
    "Event must arrive at the current unfinished step": "Сообщение принимается только на текущем незавершённом шаге",
    "add_jobs requires exactly id, at_step, type, jobs": "Для добавления заданий нужны только поля id, at_step, type, jobs",
    "jobs must be a nonempty list": "Список jobs должен содержать хотя бы одно задание",
    "Every job must be an object": "Каждое задание должно быть объектом JSON",
    "A new job cannot be released before announcement": "Начало нового задания не может предшествовать получению сообщения",
    "New job fields must match the published job schema": "Поля нового задания должны соответствовать схеме организаторов",
    "Outage fields must match the published event schema": "Для ограничения нужны только поля id, at_step, type, satellite_ids, end_step",
    "Invalid outage interval": "Конец ограничения должен быть позже текущего шага и не позже конца смены",
    "satellite_ids must be a nonempty list of strings": "Укажите непустой список строковых идентификаторов аппаратов",
    "Unknown or duplicate satellite in event": "В сообщении есть неизвестный или повторяющийся аппарат",
    "Unsupported event type": "Неизвестный тип сообщения",
    "Duplicate job ID": "Идентификатор задания уже используется",
    "Invalid job kind": "Тип задания должен быть relay или downlink",
    "Invalid job bounds": "Проверьте окно задания, объём работы, приоритет 1–3 и неотрицательную стоимость",
    "Invalid job eligibility": "Укажите существующих допустимых исполнителей без повторов",
    "A downlink job has exactly one eligible satellite": "У задания передачи на Землю должен быть ровно один допустимый аппарат",
    "Unsupported scenario schema": "Неизвестная версия схемы сценария",
    "Missing scenario section": "В сценарии отсутствует обязательный раздел",
    "Invalid battery capacity or initial charge": "Ёмкость батареи должна быть положительной, начальный заряд — от 0 до 100%",
    "Missing or non-finite satellite field": "Не все параметры аппарата заданы конечными числами",
    "Negative power": "Мощность не может быть отрицательной",
    "Satellite IDs must be unique": "Идентификаторы аппаратов не должны повторяться",
    "Environment keys must match satellite IDs": "Условия среды должны быть заданы для всех аппаратов и только для них",
    "Invalid solar power": "Солнечная мощность должна быть конечным неотрицательным числом",
    "Invalid thermal target": "Температура среды должна быть конечным числом",
    "Availability must contain booleans": "Доступность контактов задаётся значениями true или false",
    "Missing or non-finite model value": "Не все параметры модели заданы конечными числами",
    "Invalid model parameters": "Параметры модели выходят за допустимые пределы",
    "Invalid failure satellite": "В отказе указан неизвестный аппарат",
    "Invalid failure interval": "Интервал отказа должен находиться внутри смены и иметь положительную длину",
    "Time grid: 1..288 steps, 300 seconds per step": "Смена содержит от 1 до 288 шагов по 300 секунд",
    "satellites must contain 1..48 objects": "Список аппаратов должен содержать от 1 до 48 объектов",
    "Invalid stopping step": "Некорректный шаг остановки",
    "Events and commands must be lists": "Сообщения и команды должны быть списками",
    "Invalid or duplicate event record": "Некорректная или повторяющаяся запись сообщения",
    "Events must be in receipt order and not after the saved state": "Сообщения должны идти по времени получения и не позже сохранённого состояния",
    "Command must precede the saved state": "Команда должна предшествовать сохранённому состоянию",
    "Invalid/duplicate satellite command": "Некорректная или повторяющаяся команда аппарату",
}

REASONS = {
    "satellite_unavailable": "аппарат недоступен",
    "unknown_job": "задание не найдено",
    "already_completed": "задание уже выполнено",
    "outside_job_window": "шаг вне окна задания",
    "ineligible_satellite": "аппарат не входит в число допустимых исполнителей",
    "no_contact": "нет контакта",
    "calibration_required": "требуется калибровка",
    "energy_reserve": "недостаточно энергии с учётом резерва",
    "thermal_limit": "температура за допустимыми пределами",
    "ground_capacity": "каналы связи с Землёй заняты",
    "duplicate_job_in_step": "задание уже назначено другому аппарату",
    "satellite_busy": "аппарат занят",
    "accepted": "действие разрешено", "idle": "ожидание",
    "unknown_action": "неизвестное действие",
}

NOTES = {
    "planned": "действие из плана на текущее окно",
    "earliest_deadline": "выбрано задание с ближайшим сроком",
    "goal_priority": "выбор по приоритету и запасу времени",
    "goal_revenue": "выбор по стоимости на оставшуюся возможность связи до срока",
    "calibration_expired": "истёк срок калибровки",
    "calibration_ahead": "калибровка заранее на свободном шаге",
}


def model_error(exc):
    text = str(exc)
    if text in _ERRORS:
        return _ERRORS[text]
    if isinstance(exc, KeyError):
        return f"Отсутствует обязательное поле {text}"
    replacements = (
        (r"(.+) must be an integer", r"\1: требуется целое число"),
        (r"(.+): expected an integer >= (\d+)", r"\1: требуется целое число не меньше \2"),
        (r"(.+): expected a nonempty string", r"\1: требуется непустая строка"),
        (r"(.+): expected (\d+) values", r"\1: требуется ровно \2 значений"),
        (r"(.+) must be an object", r"\1: требуется объект JSON"),
        (r"(.+) must be a list", r"\1: требуется список"),
        (r"(?:Unknown|Invalid) (?:action(?: fields)?|satellite) (?:for|in) (.+)", r"Некорректная команда аппарату: \1"),
    )
    for pattern, replacement in replacements:
        if re.fullmatch(pattern, text):
            return re.sub(pattern, replacement, text)
    if re.search("[а-яА-ЯёЁ]", text):
        return text
    return "Данные не соответствуют схеме модели; проверьте типы и обязательные поля"


def planner_note(note):
    if not note:
        return "нет записи; причина простоя не доказана"
    if note.startswith("fallback_"):
        return "запасной выбор эвристики: " + planner_note(note[len("fallback_"):])
    if note.startswith("plan_rejected:"):
        return "плановое действие отклонено: " + REASONS.get(note.split(":", 1)[1], "ограничение модели")
    return NOTES.get(note, "причина не расшифрована")


def action_text(action):
    kind = action.get("action", "idle")
    return (f"выполнение задания {action.get('job_id', '')}" if kind == "job" else
            {"idle": "ожидание", "calibrate": "калибровка"}.get(kind, "неизвестное действие"))
