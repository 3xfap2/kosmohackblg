"""Таблица EDF → эвристика → CP-SAT из проверенной полной матрицы."""
import json
from pathlib import Path

from core.planner import make_planner

ROOT = Path(__file__).resolve().parents[1]
ALGORITHMS = ("edf-baseline", "goal-greedy", "horizon-cpsat")
SCENARIOS = ("P01_intro", "P02_shift", "P03_energy", "P04_demand")


def report(root=ROOT):
    runs = json.loads((root / "results/summary.json").read_text(encoding="utf-8"))["runs"]
    timings = json.loads((root / "results/timings.json").read_text(encoding="utf-8"))
    lines = ["# Вклад частей планировщика", "",
        "Источник: summary.json и выгрузки runs/. Каждый расчёт повторён с теми же командами, "
        "сводка и журнал проверены replay официальной модели. EDF — отдельное простое правило. "
        "Гибрид начинает поиск с плана goal-greedy, проверяет оба плана официальной моделью на одном окне "
        "и выбирает CP-SAT только при лучшей целевой оценке. Это не гарантия улучшения всей смены.",
        "", "| Сценарий | Цель | Алгоритм | P3 в срок | Выполнено | Выручка, $ | CP-SAT выбран / окон | Время, с |",
        "|---|---|---|---:|---:|---:|---:|---:|"]
    for scenario in SCENARIOS:
        for goal in ("priority", "revenue"):
            for algorithm in ALGORITHMS:
                key = f"{scenario}__{algorithm}__{goal}"
                row = runs[key]
                planner = make_planner(algorithm, goal)
                if (row["algorithm_version"] != planner.version or row["parameters"] != planner.params
                        or not row.get("repeat_match") or not row.get("replay_match")):
                    raise ValueError(f"{key}: нужны свежие повторные результаты")
                summary = row["summary"]
                if summary["blocked_command_count"]:
                    raise ValueError(f"{key}: модель отклонила команды")

                def cell(field):
                    value = summary[field]
                    marker = "{{result:runs." + key + ".summary." + field + "=" + str(value) + "}}"
                    return f"{value} <!-- {marker} -->"

                lines.append(f"| {scenario[:3]} | {goal} | {algorithm} {planner.version} | "
                    f"{cell('critical_jobs_completed_on_time')} | {cell('jobs_completed')} | "
                    f"{cell('revenue_usd')} | {row['cpsat_selected_solves']} / {row['solves']} | {timings[key]:.2f} |")
    lines += ["", "Время — измерение на машине разработки, не обещание времени на Vercel. "
        "Лимит CP-SAT 0.5 — детерминированные единицы работы, а не секунды. "
        "Равенство или ухудшение относительно эвристики/EDF оставлено в таблице без отбора удачных случаев.",
        "", "## Перестройка при сообщениях P02", "",
        "| Цель | Режим | P3 в срок | Выручка, $ |",
        "|---|---|---:|---:|"]
    for goal in ("priority", "revenue"):
        for mode in ("adaptive", "frozen"):
            key = f"P02_events__{mode}__{goal}"
            row = runs[key]
            if (row["algorithm_version"] != make_planner("horizon-cpsat").version
                    or not row.get("repeat_match") or not row.get("replay_match")):
                raise ValueError(f"{key}: нужны свежие повторные результаты")
            m = row["summary"]
            lines.append(f"| {goal} | {mode} | {m['critical_jobs_completed_on_time']} | {m['revenue_usd']} |")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    path = ROOT / "results/ablation.md"
    path.write_text(report(), encoding="utf-8")
    print(path.relative_to(ROOT))
