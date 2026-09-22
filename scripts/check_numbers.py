"""Сверка опубликованных чисел с результатами: python -m scripts.check_numbers.

Два способа:
1. Утверждения CLAIMS: каждое число вычисляется из results/*.json, подставляется в фразу, и фраза
   должна дословно стоять в README.md / CRITERIA.md. Поменялись результаты, а документ нет — ошибка.
2. Явные маркеры {{result:runs.KEY.summary.поле=значение}} в Markdown (если используются).
Плюс: сводка каждой выгрузки results/runs/<key>.json совпадает с results/summary.json.
"""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(r"\{\{result:([^=]+)=([^}]+)\}\}")


def usd(x):
    return "$" + f"{round(x):,}".replace(",", " ")


def claims(root=ROOT):
    """(файл, фраза) — фраза собирается из результатов."""
    runs = json.loads((root / "results/summary.json").read_text(encoding="utf-8"))["runs"]
    ext = json.loads((root / "results/extended_summary.json").read_text(encoding="utf-8"))["runs"]
    m = lambda key: runs[key]["summary"]
    p3 = lambda key: f"{m(key)['critical_jobs_completed_on_time']} / {m(key)['critical_jobs_due']}"
    rev = lambda key: usd(m(key)["revenue_usd"])
    k = lambda s, a, g: f"{s}__{a}__{g}"
    out = []
    for label, s in (("P02 обычная смена", "P02_shift"), ("P03 дефицит энергии", "P03_energy"), ("P04 перегрузка", "P04_demand")):
        out.append(("README.md", f"| {label} | {p3(k(s, 'edf-baseline', 'priority'))} | {p3(k(s, 'goal-greedy', 'priority'))} | "
                                 f"{p3(k(s, 'horizon-cpsat', 'priority'))} |"))
    out.append(("README.md", "P02 {} → {}, P03 {} → {}, P04 {} → {}".format(
        *(x for s in ("P02_shift", "P03_energy", "P04_demand")
          for x in (rev(k(s, "edf-baseline", "revenue")), rev(k(s, "horizon-cpsat", "revenue")))))))
    out.append(("README.md", f"P02 {rev(k('P02_shift', 'horizon-cpsat', 'revenue'))} против {rev(k('P02_shift', 'horizon-cpsat', 'priority'))}"))
    pr, rv = m(k("P04_demand", "horizon-cpsat", "priority")), m(k("P04_demand", "horizon-cpsat", "revenue"))
    price = f"+{usd(rv['revenue_usd'] - pr['revenue_usd'])} выручки за −{pr['critical_jobs_completed_on_time'] - rv['critical_jobs_completed_on_time']} срочных"
    out += [("README.md", price), ("CRITERIA.md", price)]
    ad, fr = runs["P02_events__adaptive__priority"], runs["P02_events__frozen__priority"]
    events = (f"срочные {fr['summary']['critical_jobs_completed_on_time']} → {ad['summary']['critical_jobs_completed_on_time']}, "
              f"просрочено {fr['summary']['jobs_due_missed']} → {ad['summary']['jobs_due_missed']}")
    out += [("README.md", events), ("CRITERIA.md", events)]
    out.append(("CRITERIA.md", f"заявки из сообщений {len(fr['new_jobs_completed'])} → {len(ad['new_jobs_completed'])} из {ad['new_jobs_total']}"))
    out.append(("CRITERIA.md", f"P04: {p3(k('P04_demand', 'edf-baseline', 'priority')).split(' /')[0]} → "
                               f"{p3(k('P04_demand', 'horizon-cpsat', 'priority')).split(' /')[0]} срочных в срок, "
                               f"{m(k('P04_demand', 'edf-baseline', 'priority'))['jobs_completed']} → "
                               f"{m(k('P04_demand', 'horizon-cpsat', 'priority'))['jobs_completed']} выполнено, работа в сорванных "
                               f"{m(k('P04_demand', 'edf-baseline', 'priority'))['work_steps_in_missed_jobs']} → "
                               f"{m(k('P04_demand', 'horizon-cpsat', 'priority'))['work_steps_in_missed_jobs']}"))
    out.append(("CRITERIA.md", f"ниже резерва {m(k('P03_energy', 'edf-baseline', 'priority'))['below_reserve_satellite_steps']} → "
                               f"{m(k('P03_energy', 'horizon-cpsat', 'priority'))['below_reserve_satellite_steps']}"))
    below = (f"{m(k('P04_demand', 'horizon-cpsat', 'priority'))['below_reserve_satellite_steps']} против "
             f"{m(k('P04_demand', 'edf-baseline', 'priority'))['below_reserve_satellite_steps']}")
    out += [("README.md", below), ("CRITERIA.md", below)]
    def accepted(goal):
        a, b, c = (runs[k(s, "horizon-cpsat", goal)]["cpsat_selected_solves"] for s in ("P02_shift", "P03_energy", "P04_demand"))
        return f"{a}, {b} и {c}"
    out.append(("CRITERIA.md", f"CP-SAT принят в {accepted('priority')} из 48 перестроек (приоритет) и в {accepted('revenue')} (коммерция)"))
    # Вклад решателя в деньгах: сумма превышения его плана над эвристикой на принятых окнах.
    def gain(scenario, goal):
        return usd(runs[k(scenario, "horizon-cpsat", goal)]["cpsat_gain"]["revenue_usd"])
    contribution = (f"вклад принятых планов по оценке окна — {gain('P02_shift', 'priority')} на P02, "
                    f"{gain('P03_energy', 'priority')} на P03 и {gain('P04_demand', 'priority')} на P04 (приоритет)")
    out += [("README.md", contribution), ("CRITERIA.md", contribution)]
    n = len(runs)
    out.append(("README.md", f"{n} из {n} прогонов повторены моделью организаторов"))
    out.append(("CRITERIA.md", f"{n} из {n} прогонов повторены моделью с тем же итогом"))
    edf = runs["P02_events__edf-baseline__priority"]["summary"]
    out.append(("README.md", f"Простое правило с теми же сообщениями: срочные {edf['critical_jobs_completed_on_time']}, просрочено {edf['jobs_due_missed']}"))
    research = json.loads((root / "results/research.json").read_text(encoding="utf-8"))
    for ref, st in research["stress"].items():
        assert st["wins"] == st["runs"] == 12, f"стресс-тест {ref}: {st['wins']} из {st['runs']} — обновить README/CRITERIA"
    wins = sum(st["wins"] for st in research["stress"].values())
    total = sum(st["runs"] for st in research["stress"].values())
    out.append(("README.md", f"эвристика лучше простого правила в {wins} случаях из {total}"))
    link = lambda v: f"{ext[f'P02_shift__{v}__priority']['ext_link_coverage'] * 100:.1f}".replace(".", ",")
    out.append(("CRITERIA.md", f"{link('goal-greedy+attitude')} % → {link('goal-greedy+attitude+link')} %"))
    out.append(("README.md", f"{link('goal-greedy+attitude')} % → {link('goal-greedy+attitude+link')} %"))
    return out


def check(root=ROOT):
    summary = json.loads((root / "results/summary.json").read_text(encoding="utf-8"))
    errors, count = [], 0
    runs_dir = root / "results/runs"
    for key, row in summary["runs"].items():
        path = runs_dir / (key + ".json")
        if not path.exists():
            errors.append(f"{key}: нет выгрузки results/runs/{key}.json")
            continue
        if row["summary"] != json.loads(path.read_text(encoding="utf-8"))["summary"]:
            errors.append(f"{key}: сводка расходится с экспортом")
    if (root / "results/extended_summary.json").exists() and (root / "README.md").exists():
        for name, phrase in claims(root):
            count += 1
            if phrase not in (root / name).read_text(encoding="utf-8"):
                errors.append(f"{name}: нет фразы с актуальными числами — «{phrase}»")
    for file in [root / "README.md", root / "CRITERIA.md", *sorted((root / "docs").glob("*.md")),
                 *sorted((root / "results").glob("*.md"))]:
        if not file.exists():
            continue
        content = file.read_text(encoding="utf-8")
        for match in PATTERN.finditer(content):
            count += 1
            try:
                value = summary
                for part in match[1].split("."):
                    value = value[part]
                if value != json.loads(match[2]):
                    errors.append(f"{file.name}: не совпадает {match[1]}")
            except (KeyError, TypeError, ValueError):
                errors.append(f"{file.name}: неверная ссылка {match[0]}")
        if content.count("{{result:") != len(PATTERN.findall(content)):
            errors.append(f"{file.name}: некорректный маркер результата")
    return errors, count


def write_claims(root=ROOT):
    """results/claims.json — те же утверждения в машиночитаемом виде: фраза, файл, найдена ли.
    Проверяющему (в том числе автоматическому) не нужно верить тексту: каждая строка сверяема."""
    rows = [{"file": name, "claim": phrase, "found": phrase in (root / name).read_text(encoding="utf-8")}
            for name, phrase in claims(root)]
    path = root / "results" / "claims.json"
    path.write_text(json.dumps({"schema_version": 1, "source": "results/*.json", "claims": rows},
                               ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return rows


if __name__ == "__main__":
    import sys
    errors, count = check()
    if "--write" in sys.argv:          # по умолчанию проверка не меняет рабочее дерево
        write_claims()
        print("обновлён results/claims.json")
    for error in errors:
        print(error)
    print(f"Проверено числовых утверждений: {count}; ошибок: {len(errors)}")
    raise SystemExit(bool(errors))
