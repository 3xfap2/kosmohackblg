import { useState } from "react";
import type { Explanation, WhyNot } from "../api/types";
import { usd } from "../format";
import { GROUP, LOSS } from "../format";

// «Почему?» — какие сведения были доступны, что ограничило, чем закончилось.
// Группа потери показывается явно: ограничение задачи (с доказательством) или решение алгоритма.
export default function ExplainPanel({ e, whyNot, missed }: {
  e: Explanation | null; missed?: boolean; whyNot?: (jobId: string) => Promise<WhyNot>;
}) {
  const [wn, setWn] = useState<{ id: string; r?: WhyNot; err?: string; busy?: boolean } | null>(null);
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
      {missed && whyNot && e.subject.job_id && e.loss?.group !== "problem_limit" && (() => {
        const id = e.subject.job_id;
        const cur = wn?.id === id ? wn : null;
        return (
          <div className="whynot">
            {!cur?.r && <button className="btn" disabled={cur?.busy} onClick={() => {
              setWn({ id, busy: true });
              whyNot(id).then((r) => setWn({ id, r })).catch((x) => setWn({ id, err: x.message }));
            }}>{cur?.busy ? "Проверяю моделью…" : "Можно ли было выполнить?"}</button>}
            {cur?.err && <p className="error">{cur.err}</p>}
            {cur?.r && (cur.r.verdict === "impossible"
              ? <p className="finding">Нельзя: {cur.r.proof?.proof}</p>
              : cur.r.verdict === "possible"
                ? <p className="finding">Можно — но ценой {cur.r.displaced?.length ? cur.r.displaced.map((j) => `${j.id} (P${j.priority}, ${usd(j.value_usd)})`).join(", ") : "ничего"}
                    {cur.r.gained?.length ? `; попутно выполнилось бы ${cur.r.gained.map((j) => j.id).join(", ")}` : ""}.</p>
                : <p className="finding">Даже при приоритетном назначении не выполняется — не хватило допустимых шагов.</p>)}
            {cur?.r?.note && <p className="muted tiny">{cur.r.note}</p>}
          </div>
        );
      })()}
    </div>
  );
}
