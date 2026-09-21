import type { Explanation } from "../api/types";
import { GROUP, LOSS } from "../format";

// «Почему?» — какие сведения были доступны, что ограничило, чем закончилось.
// Группа потери показывается явно: ограничение задачи (с доказательством) или решение алгоритма.
export default function ExplainPanel({ e }: { e: Explanation | null }) {
  if (!e) return <p className="muted">Выберите задание в таблице или ячейку расписания.</p>;
  return (
    <div className="explain">
      <p className="mono">
        {e.subject.job_id && <span className="id">{e.subject.job_id}</span>}
        {e.subject.satellite_id && <> <span className="id">{e.subject.satellite_id}</span> · шаг {e.subject.step}</>}
      </p>
      {e.loss && (
        <p className={"loss big " + e.loss.group}>
          {GROUP[e.loss.group]} — {LOSS[e.loss.code] ?? e.loss.code}
        </p>
      )}
      <h4>Что было известно</h4>
      <ul>{e.known_at_decision.map((k, i) => <li key={i}>{k}</li>)}</ul>
      {e.constraint && (<><h4>Что ограничило</h4><p>{LOSS[e.constraint] ?? e.constraint}</p></>)}
      <h4>{e.loss?.group === "problem_limit" ? "Доказательство" : "Последствие"}</h4>
      <p>{e.consequence}</p>
    </div>
  );
}
