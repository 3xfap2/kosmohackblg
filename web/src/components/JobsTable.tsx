import { markJury } from "../jury";
import { useMemo, useState } from "react";
import type { JobView } from "../api/types";
import { GROUP, KIND, LOSS, STATUS, clock, usd } from "../format";
import { Term } from "../glossary";

const DOT: Record<string, string> = {
  completed: "var(--ok)", missed: "var(--bad)", in_progress: "var(--info)", open: "var(--text-muted)", waiting: "var(--text-faint)",
};

export default function JobsTable({ jobs, onPick, picked }: {
  jobs: JobView[]; onPick: (id: string) => void; picked?: string;
}) {
  const [status, setStatus] = useState("missed");
  const [prio, setPrio] = useState(0);
  const rows = useMemo(
    () => jobs.filter((j) => (status === "all" || j.status === status) && (!prio || j.priority === prio)),
    [jobs, status, prio],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const j of jobs) c[j.status] = (c[j.status] ?? 0) + 1;
    return c;
  }, [jobs]);

  return (
    <div>
      <div className="filters">
        {["missed", "completed", "in_progress", "open", "all"].map((s) => (
          <button key={s} className={"chip" + (status === s ? " on" : "")} onClick={() => setStatus(s)}>
            {s === "all" ? "все" : STATUS[s]} <span className="mono muted">{s === "all" ? jobs.length : counts[s] ?? 0}</span>
          </button>
        ))}
        <span className="sep" />
        {[0, 3, 2, 1].map((p) => (
          <button key={p} className={"chip" + (prio === p ? " on" : "")} onClick={() => setPrio(p)}>
            {p ? `P${p}` : "любой приоритет"}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Задание</th><th>Тип</th><th><Term k="p3">Приоритет</Term></th><th>Окно</th><th>Работа</th><th>Стоимость</th><th>Исполнители</th><th>Итог / причина</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 300).map((j) => (
              <tr key={j.id} className={picked === j.id ? "picked" : ""} onClick={() => { onPick(j.id); markJury("explain"); }}>
                <td><span className="id">{j.id}</span>{j.source !== "plan" && <span className="tag">{j.source}</span>}</td>
                <td>{KIND[j.kind] ?? j.kind}</td>
                <td className="mono">{j.priority}</td>
                <td className="mono muted">{clock(j.release_step)}–{clock(j.deadline_step)}</td>
                <td className="mono">{j.done_steps}/{j.work_steps}</td>
                <td className="mono">{usd(j.value_usd)}</td>
                <td className="mono muted">{(j.executors.length ? j.executors : j.eligible_satellites).join(" ")}</td>
                <td>
                  <span className="dot" style={{ background: DOT[j.status] }} />{STATUS[j.status]}
                  {j.loss ? (
                    <span className={"loss " + j.loss.group}>{GROUP[j.loss.group]}: {LOSS[j.loss.code] ?? j.loss.code}</span>
                  ) : j.status === "missed" && <span className="loss">причина не установлена — доказательств недостаточно</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 300 && <p className="muted">Показаны первые 300 из {rows.length}. Уточните фильтр.</p>}
      </div>
    </div>
  );
}
