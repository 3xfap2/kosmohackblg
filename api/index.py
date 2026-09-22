"""Точка входа для Vercel: ASGI-приложение сервиса.

Vercel ищет функции в папке api/. Сам сервис живёт в server/main.py — здесь только
подключение корня репозитория к путям импорта и экспорт приложения.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.main import app   # noqa: E402  — путь добавляется выше

__all__ = ["app"]
