"""Сверка файлов организаторов с их исходной копией: model/, data/, examples/ не изменены.

Проверяющий берёт свою копию материалов кейса и запускает:
    python -m scripts.check_inputs --case "путь к папке Кейс 1"

Без ключа сверяются хеши из results/INPUTS.sha256 (они же попадают в архив сдачи):
    python -m scripts.check_inputs
"""
import argparse
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = ("model/*.py", "data/*.json", "examples/*.json")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files() -> list[Path]:
    return sorted(p for pattern in PATTERNS for p in ROOT.glob(pattern))


def manifest() -> dict[str, str]:
    lines = (ROOT / "results" / "INPUTS.sha256").read_text(encoding="utf-8").split("\n")
    return dict(reversed(line.split("  ", 1)) for line in lines if line)


def main() -> int:
    parser = argparse.ArgumentParser(description="Сверка файлов организаторов")
    parser.add_argument("--case", help="папка с исходными материалами кейса (model, data, examples)")
    case = parser.parse_args().case
    errors = []
    listed = manifest()
    present = {p.relative_to(ROOT).as_posix() for p in files()}
    for missing in sorted(set(listed) - present):
        errors.append(f"{missing}: файл есть в манифесте, но отсутствует в репозитории")
    for extra in sorted(present - set(listed)):
        errors.append(f"{extra}: файл есть в репозитории, но его нет в манифесте")
    for path in files():
        name = path.relative_to(ROOT).as_posix()
        if listed.get(name) != sha256(path):
            errors.append(f"{name}: хеш в репозитории не совпадает с results/INPUTS.sha256")
        if case:
            original = Path(case) / name
            if not original.exists():
                errors.append(f"{name}: нет в папке кейса — {original}")
            elif sha256(original) != sha256(path):
                errors.append(f"{name}: файл отличается от копии организаторов")
    source = f"копией организаторов ({case})" if case else "манифестом results/INPUTS.sha256"
    print(f"Проверено файлов: {len(files())}; сверка с {source}; расхождений: {len(errors)}")
    for line in errors:
        print(" -", line)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
