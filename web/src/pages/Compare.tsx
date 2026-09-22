import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, isStaleVersion, rebuildRun } from "../api/client";
import type { Goal } from "../api/types";
import { store } from "../api/store";
import type { Comparison, RunRecord } from "../api/types";
import TwinOrbits from "../features/TwinOrbits";
import { ALGO, GOAL, usd } from "../format";

// Показатели сравнения (core/comparison.py) — по-русски и в единицах оператора.
const METRIC: Record<string, [string, (x: number) => string]> = {
  critical_jobs_completed_on_time: ["Срочные (P3) в срок", String],
  revenue_usd: ["Выручка", (x) => (x < 0 ? "−" : "") + usd(Math.abs(x))],
  jobs_completed: ["Выполнено заданий", String],
  jobs_due_missed: ["Просрочено заданий", String],
  mean_terminal_soc_pct: ["Средний заряд в конце", (x) => x.toFixed(1) + "%"],
  min_terminal_soc_pct: ["Минимальный заряд в конце", (x) => x.toFixed(1) + "%"],
  minimum_soc_pct: ["Минимальный заряд", (x) => x.toFixed(1) + "%"],
  below_reserve_satellite_steps: ["Ниже резерва, ап.-шагов", String],
  work_steps_in_missed_jobs: ["Работа в сорванных заданиях, шагов", String],
};
const fmt = (name: string, x: number | null) => (x == null ? "—" : (METRIC[name]?.[1] ?? String)(x));

// Сравнение двух запусков: вердикт ядра для выбранной цели, происхождение ветвей и различия.
export default function Compare() {
  const [verdictGoal, setVerdictGoal] = useState<Goal>("priority");
  const [params] = useSearchParams();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [a, setA] = useState(params.get("a") ?? "");
  const [b, setB] = useState(params.get("b") ?? "");
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { store.all().then(setRuns); }, []);
  // Из шапки смены («Сравнить с родителем») приходят обе смены — сравниваем сразу.
  useEffect(() => {
    if (params.get("a") && params.get("b") && runs.length && !cmp && !busy) run();
  }, [runs]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = (r: RunRecord) =>
    `${r.id.slice(0, 8)} · ${"ref" in r.scenario ? r.scenario.ref : "свой"} · ${GOAL[r.run_metadata.goal]} · ${ALGO[r.run_metadata.algorithm]} · шаг ${r.steps_executed}`;

  const run = async () => {
    const ra = runs.find((r) => r.id === a), rb = runs.find((r) => r.id === b);
    if (!ra || !rb) return;
    setBusy(true); setError(null);
    try {
      try { setCmp(await api.compare(ra, rb)); }
      catch (e) {
        if (!isStaleVersion(e)) throw e;
        // Одна из смен рассчитана прежней версией алгоритма — пересчитываем обе текущей и сравниваем.
        const [na, nb] = await Promise.all([ra, rb].map(async (r) => { const x = (await rebuildRun(r)).run; await store.save(x); return x; }));
        setRuns((all) => all.map((r) => (r.id === na.id ? na : r.id === nb.id ? nb : r)));
        setCmp(await api.compare(na, nb));
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="setup">
      <h1>Сравнение вариантов</h1>
      <section className="card">
        <p className="muted small">Честное сравнение — ветви из одного состояния (кнопка «Ветвь» в смене) или разные цели/алгоритмы на одном сценарии.</p>
        <div className="form-row">
          {[["A", a, setA], ["B", b, setB]].map(([name, val, set]) => (
            <label key={name as string} className="field">Вариант {name as string}
              <select className="select mono" value={val as string} onChange={(e) => (set as (v: string) => void)(e.target.value)}>
                <option value="">— выберите —</option>
                {runs.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
              </select>
            </label>
          ))}
        </div>
        <button className="btn btn-primary" disabled={!a || !b || a === b || busy} onClick={run}>{busy ? "Сравнение…" : "Сравнить"}</button>
        {error && <p className="error">{error}</p>}
      </section>

      {cmp && (
        <section className="card">
          <div className="row">
            <span className="muted small">Цель сравнения:</span>
            <div className="seg">
              {(["priority", "revenue"] as const).map((g) => (
                <button key={g} className={g === verdictGoal ? "on" : ""} onClick={() => setVerdictGoal(g)}>{GOAL[g]}</button>
              ))}
            </div>
          </div>
          <p className={"verdict " + (cmp.verdict.by_goal?.[verdictGoal] ?? cmp.verdict.preferred)}>
            {cmp.verdict.preferred === "incomparable" ? "Несопоставимо: условия вариантов различаются"
              : (cmp.verdict.by_goal?.[verdictGoal] ?? cmp.verdict.preferred) === "comparable" ? "Результаты сопоставимы"
              : `Для цели «${GOAL[verdictGoal]}» предпочтительнее вариант ${(cmp.verdict.by_goal?.[verdictGoal] ?? cmp.verdict.preferred).toUpperCase()}`}
          </p>
          <p>{cmp.verdict.reason}</p>
          {cmp.verdict.by_goal && cmp.verdict.preferred !== "incomparable" && (
            <p className="small mono">{(["priority", "revenue"] as const).map((g) => {
              const w = cmp.verdict.by_goal![g];
              return `${GOAL[g]}: ${w === "comparable" ? "равно" : `лучше ${w.toUpperCase()}`}`;
            }).join(" · ")}</p>
          )}
          <p className="mono small muted">
            {cmp.same_origin ? `✓ общее исходное состояние (развилка на шаге ${cmp.fork_step})` : "варианты не из одного состояния — сравнение по итогам смены"}
            {" · "}{cmp.same_events_after_fork ? "✓ одинаковые сообщения после развилки" : "⚠ сообщения после развилки различаются"}
          </p>
          <table className="table">
            <thead><tr><th>Показатель</th><th>A</th><th>B</th><th>Разница B − A</th><th>Лучше</th></tr></thead>
            <tbody>
              {cmp.metrics.map((m) => (
                <tr key={m.name}>
                  <td>{METRIC[m.name]?.[0] ?? m.name}</td>
                  <td className="mono">{fmt(m.name, m.a)}</td>
                  <td className="mono">{fmt(m.name, m.b)}</td>
                  <td className="mono">{m.delta == null ? "—" : (m.delta > 0 ? "+" : "") + fmt(m.name, m.delta)}</td>
                  <td>{m.better === "equal" ? "равно" : m.better.toUpperCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {cmp && runs.find((r) => r.id === a) && runs.find((r) => r.id === b) && (
        <TwinOrbits key={a + b} a={runs.find((r) => r.id === a)!} b={runs.find((r) => r.id === b)!} forkStep={cmp.fork_step} />
      )}
    </div>
  );
}
