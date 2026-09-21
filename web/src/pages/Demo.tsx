import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { Explanation, JobView, RunView, StepRow } from "../api/types";
import RunDashboard from "../components/RunDashboard";
import { fromTrace } from "../lib/cells";
import { ALGO, GOAL, clock } from "../format";

// Демо: сохранённый прогон ядра (/demo/<алгоритм>_*.json) — для показа без расчёта.
interface Data { view: RunView; jobs: JobView[]; trace: StepRow[]; explain: Record<string, Explanation> }

export default function Demo() {
  const { alg = "edf-baseline" } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const get = (n: string) => fetch(`/demo/${alg}_${n}.json`).then((r) => {
      if (!r.ok) throw new Error(`нет демо-данных ${alg}_${n}.json`);
      return r.json();
    });
    Promise.all([get("view"), get("jobs"), get("trace"), get("explain")])
      .then(([view, jobs, trace, explain]) => setData({ view, jobs, trace, explain }))
      .catch((e) => setError(e.message));
  }, [alg]);

  const board = useMemo(() => {
    if (!data) return null;
    const kindOf = Object.fromEntries(data.jobs.map((j) => [j.id, j.kind]));
    return fromTrace(data.trace, kindOf, data.view.steps_total);
  }, [data]);

  const explain = useCallback(async (jobId: string): Promise<Explanation> => data?.explain[jobId] ?? {
    subject: { job_id: jobId }, known_at_decision: [], constraint: null,
    consequence: data?.jobs.find((j) => j.id === jobId)?.status === "completed" ? "Выполнено в срок." : "Объяснение для этого задания не сохранено в демо-данных.",
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!data || !board) return <p className="muted">Загрузка прогона…</p>;
  const v = data.view;
  return (
    <>
      <div className="run-head">
        <div className="bar-info">
          <span className="id">{v.scenario_id}</span>
          <span className="muted">{GOAL[v.goal]}</span>
          <span className="muted">{ALGO[v.algorithm.name]}</span>
        </div>
        <div className="bar-step mono">шаг {v.step}/{v.steps_total} · {clock(v.step)}</div>
      </div>
      <p className="banner mono">Демо-режим: сохранённый прогон P02 + события events_demo.json. Для управления сменой создайте запуск в разделе «Смены».</p>
      <RunDashboard view={v} jobs={data.jobs} board={board} explain={explain}
        initialStep={params.get("t") ? Number(params.get("t")) : undefined} />
    </>
  );
}
