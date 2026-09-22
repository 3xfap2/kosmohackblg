"""Браузерные проверки сценария оператора (playwright, запускается вручную).

Зачем отдельно от pytest: нужен собранный фронтенд и запущенный сервер.
    .venv/Scripts/python -m uvicorn server.main:app --port 8000
    cd web && npx vite --port 5173
    .venv/Scripts/python tests/e2e/browser_checks.py

Проверяет то, что нельзя проверить на стороне ядра:
1) два сообщения на одном шаге получают разные идентификаторы и оба принимаются;
2) смена переносится в другой браузер файлом (у членов жюри общего хранилища нет).
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = "http://localhost:5173"
OUT = Path(__file__).resolve().parent


def new_run(page):
    page.goto(f"{BASE}/console/new")
    page.get_by_text("P01", exact=False).first.click()
    page.get_by_text("Эвристика по цели").first.click()
    page.get_by_role("button", name="Создать смену").first.click()
    page.wait_for_selector(".kpi-value", timeout=60000)


def main() -> int:
    errors: list[str] = []
    try:
        run_checks(errors)
    except Exception as exc:   # noqa: BLE001 — закрытие msedge иногда падает уже после проверок
        if "invalid state" not in str(exc) and "TargetClosed" not in type(exc).__name__:
            raise
    print("ошибки:", errors or "нет")
    return 1 if errors else 0


def run_checks(errors: list[str]) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", args=["--no-proxy-server"])
        page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        page.on("pageerror", lambda e: errors.append(f"ошибка страницы: {e}"))

        # 1. Два сообщения на одном шаге.
        new_run(page)
        page.get_by_role("button", name="+1 час").first.click()
        page.wait_for_timeout(2500)
        page.get_by_role("button", name="Сообщение").first.click()
        ids = []
        for _ in range(2):
            ids.append(page.locator("input.mono").first.input_value())
            page.locator(".sat").first.click()
            page.get_by_role("button", name="Отправить").first.click()
            page.wait_for_timeout(1500)
        events = page.locator(".rh-tick").count()
        if ids[0] == ids[1]:
            errors.append(f"второе сообщение предложило тот же номер: {ids}")
        if events < 2:
            errors.append(f"в журнале смены {events} сообщений вместо двух")
        print("сообщения:", ids, "| в журнале:", events)

        # 2. Перенос смены файлом в другой браузерный профиль.
        page.get_by_role("button", name="Управление").first.click()
        page.wait_for_timeout(500)
        with page.expect_download() as got:
            page.get_by_role("button", name="Файл смены для переноса").click()
        path = OUT / "run_transfer.json"
        got.value.save_as(path)
        record = json.loads(path.read_text(encoding="utf-8"))
        other = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        other.on("pageerror", lambda e: errors.append(f"ошибка страницы (второй браузер): {e}"))
        other.goto(f"{BASE}/console/runs")
        other.wait_for_timeout(1000)
        other.locator("input[type=file]").first.set_input_files(str(path))
        other.wait_for_selector(".kpi-value", timeout=120000)
        opened = other.url.rsplit("/", 1)[-1]
        if opened != record["id"]:
            errors.append(f"после загрузки открылась смена {opened}, ожидалась {record['id']}")
        print("перенос смены:", opened)
        path.unlink(missing_ok=True)
        try:
            browser.close()
        except Exception:   # noqa: BLE001 — закрытие msedge иногда падает уже после проверок
            pass


if __name__ == "__main__":
    sys.exit(main())
