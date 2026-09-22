import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

// «Проверка для жюри»: основной сценарий оператора из постановки. Шаги отмечаются сами,
// когда эксперт выполняет действие. Хранится только в этом браузере — это подсказка, не учёт.
export const JURY_STEPS = [
  { id: "scenario", title: "Загрузить сценарий и выбрать цель", hint: "«Новая смена»: P01–P04 или свой JSON, условия эксперимента, цель, алгоритм", to: "/console/new" },
  { id: "advance", title: "Рассчитать до нужного шага", hint: "«Остановиться перед шагом N» или клик по шкале времени в шапке" },
  { id: "message", title: "Ввести сообщение", hint: "Вкладка «Сообщение»: форма (аппараты и конец интервала) или JSON" },
  { id: "continue", title: "Продолжить после сообщения", hint: "«+1 час» или «До конца»: план перестроится с текущего шага" },
  { id: "explain", title: "Разобрать потерю", hint: "Таблица заданий → строка → «Почему?»" },
  { id: "compare", title: "Сравнить варианты из одного состояния", hint: "«Ветвь с другой целью» → «Сравнить…»" },
  { id: "export", title: "Сохранить результат", hint: "«Скачать выгрузку JSON» — повторяется скриптом организаторов" },
] as const;
export type JuryStep = (typeof JURY_STEPS)[number]["id"];

const KEY = "sz_jury_v1";
const read = (): JuryStep[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } };

export function markJury(step: JuryStep) {
  const done = read();
  if (done.includes(step)) return;
  try { localStorage.setItem(KEY, JSON.stringify([...done, step])); } catch { /* без хранилища — только эта вкладка */ }
  window.dispatchEvent(new Event("sz-jury"));
}

export function JuryChecklist() {
  const [done, setDone] = useState<JuryStep[]>(read);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const upd = () => setDone(read());
    window.addEventListener("sz-jury", upd);
    window.addEventListener("storage", upd);
    return () => { window.removeEventListener("sz-jury", upd); window.removeEventListener("storage", upd); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  const n = JURY_STEPS.filter((s) => done.includes(s.id)).length;
  return (
    <div className="pop jury">
      <button className={"pop-btn" + (open ? " on" : "")} onClick={() => setOpen(!open)} aria-expanded={open}>
        Проверка для жюри <b className={"jury-count" + (n === JURY_STEPS.length ? " ok" : "")}>{n}/{JURY_STEPS.length}</b>
      </button>
      {open && (
        <div className="pop-panel">
          <div className="menu wide">
            <p className="menu-title">Основной сценарий из постановки — отмечается сам</p>
            <ol className="jury-list">
              {JURY_STEPS.map((s) => (
                <li key={s.id} className={done.includes(s.id) ? "done" : ""}>
                  <span className="jury-mark">{done.includes(s.id) ? "✓" : ""}</span>
                  <div>
                    <b>{"to" in s ? <Link to={s.to} onClick={() => setOpen(false)}>{s.title}</Link> : s.title}</b>
                    <span className="muted small">{s.hint}</span>
                  </div>
                </li>
              ))}
            </ol>
            {n > 0 && <button className="btn btn-sm" onClick={() => { try { localStorage.removeItem(KEY); } catch { /* */ } setDone([]); }}>Начать заново</button>}
          </div>
        </div>
      )}
    </div>
  );
}
