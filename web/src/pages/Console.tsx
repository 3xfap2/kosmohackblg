import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { Explanation, JobView, RunView, StepRow } from "../api/types";
import ExplainPanel from "../components/ExplainPanel";
import Gantt from "../components/Gantt";
import JobsTable from "../components/JobsTable";
import SocChart from "../components/SocChart";
import { ALGO, GOAL, clock, pct, usd } from "../format";
import "./console.css";

interface Data { view: RunView; jobs: JobView[]; trace: StepRow[]; explain: Record<string, Explanation> }

// Демо-режим (?demo=<алгоритм>) показывает сохранённый прогон ядра из /demo/*.json.
// Живой режим подключается к API после перехода ядра на контракт v1.
async function loadDemo(alg: string): Promise<Data> {
  const get = (n: string) => fetch(`/demo/${alg}_${n}.json`).then((r) => {
    if (!r.ok) throw new Error(`нет файла демо-данных ${alg}_${n}.json`);
    return r.json();
  });
  const [view, jobs, trace, explain] = await Promise.all([get("view"), get("jobs"), get("trace"), get("explain")]);
  return { view, jobs, trace, explain };
}

export default function Console() {
  const [params] = useSearchParams();
  const demo = params.get("demo");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sat, setSat] = useState("S01");
  const [picked, setPicked] = useState<string | undefined>();

  useEffect(() => {
    if (demo) loadDemo(demo).then((d) => {
      setData(d);
      setPicked(d.jobs.find((j) => j.status === "missed" && d.explain[j.id])?.id);
    }).catch((e) => setError(e.message));
  }, [demo]);

  const kindOf = useMemo(() => Object.fromEntries((data?.jobs ?? []).map((j) => [j.id, j.kind])), [data]);
  const satRows = useMemo(() => (data?.trace ?? []).filter((r) => r.satellite_id === sat), [data, sat]);
  const sats = useMemo(() => [...new Set((data?.trace ?? []).map((r) => r.satellite_id))].sort(), [data]);

  if (!demo) {
    return (
      <div className="console">
        <Link to="/" className="muted">← Созвездие</Link>
        <h1>Консоль оператора</h1>
        <p className="muted">Живой режим подключится после перехода ядра на контракт v1.</p>
        <p><Link className="btn" to="/console?demo=edf-baseline">Демо: P02, простое правило</Link>{" "}
          <Link className="btn" to="/console?demo=horizon-cpsat">Демо: P02, CP-SAT</Link></p>
      </div>
    );
  }
  if (error) return <div className="console"><p className="error">{error}</p></div>;
  if (!data) return <div className="console"><p className="muted">Загрузка прогона…</p></div>;

  const { view: v, jobs, trace } = data;
  const s = v.summary;
  const explanation: Explanation | null = picked ? data.explain[picked] ?? {
    subject: { job_id: picked }, known_at_decision: [], constraint: null,
    consequence: jobs.find((j) => j.id === picked)?.status === "completed"
      ? "Выполнено в срок." : "Объяснение для этого задания не выгружено в демо-данные.",
  } : null;

  return (
    <div className="console">
      <header className="bar">
        <Link to="/" className="brand">Созвездие</Link>
        <div className="bar-info">
          <span className="id">{v.scenario_id}</span>
          <span className="muted">{GOAL[v.goal]}</span>
          <span className="muted">{ALGO[v.algorithm.name]}</span>
        </div>
        <div className="bar-step mono">шаг {v.step}/{v.steps_total} · {clock(v.step)}</div>
        <div className="bar-actions">
          <button className="btn" disabled>Шаг</button>
          <button className="btn" disabled>До шага…</button>
          <button className="btn" disabled>Сообщение</button>
          <button className="btn" disabled>Ветвь</button>
          <button className="btn" disabled>Экспорт</button>
        </div>
      </header>
      <p className="banner mono">Демо-режим: сохранённый прогон P02 + события events_demo.json из ядра. Управление появится с живым API.</p>

      <section className="kpis">
        <Kpi label="Приоритет 3 в срок" value={`${s.critical_jobs_completed_on_time} / ${s.critical_jobs_due}`} sub={pct(v.kpi.p3_on_time_share)} />
        <Kpi label="Выполнено заданий" value={`${s.jobs_completed} / ${s.jobs_total}`} sub={`просрочено ${s.jobs_due_missed}`} />
        <Kpi label="Выручка смены" value={usd(s.revenue_usd)} sub={`упущено ${usd(v.kpi.revenue_lost_in_missed_usd)}`} />
        <Kpi label="Минимальный заряд" value={`${s.minimum_soc_pct.toFixed(1)}%`} sub={`ниже резерва: ${s.below_reserve_satellite_steps} ап.-шагов`} />
        <Kpi label="Отклонено моделью" value={String(s.blocked_command_count)} sub="команд" />
        <Kpi label="Загрузка аппаратов" value={pct(v.kpi.utilization)} sub="доля шагов с заданием" />
      </section>

      <div className="layout">
        <main>
          <section className="card">
            <div className="card-head">
              <h2>Расписание группировки</h2>
              <div className="legend mono">
                <i style={{ background: "var(--relay)" }} />ретрансляция
                <i style={{ background: "var(--info)" }} />на Землю
                <i style={{ background: "var(--warn)" }} />калибровка
                <i style={{ background: "var(--surface)", border: "1px solid var(--line)" }} />тень
                <i style={{ background: "var(--bad)" }} />отказ
              </div>
            </div>
            <Gantt trace={trace} kindOf={kindOf} steps={v.steps_total} currentStep={v.step} selected={sat}
              onSelect={(sid) => setSat(sid)} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Заряд аппарата <span className="id">{sat}</span></h2>
              <select value={sat} onChange={(e) => setSat(e.target.value)} className="select mono">
                {sats.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <SocChart rows={satRows} steps={v.steps_total} />
            <p className="muted small">Пунктир: жёлтый — резерв 30 % (ниже него задания и калибровка не допускаются), красный — критический 20 %.</p>
          </section>

          <section className="card">
            <div className="card-head"><h2>Задания</h2></div>
            <JobsTable jobs={jobs} onPick={setPicked} picked={picked} />
          </section>
        </main>

        <aside>
          <section className="card">
            <h2>Почему?</h2>
            <ExplainPanel e={explanation} />
          </section>
          <section className="card">
            <h2>Сообщения смены</h2>
            <ol className="events">
              {v.events.map((e) => (
                <li key={e.id}>
                  <span className="mono muted">{clock(e.at_step)}</span> <span className="id">{e.id}</span>{" "}
                  {e.type === "add_jobs" ? `новые задания: ${e.jobs.map((j) => j.id).join(", ")}`
                    : e.type === "satellite_outage" ? `недоступны ${e.satellite_ids.join(", ")} до ${clock(e.end_step)}`
                    : `отмена сеансов: ${e.satellite_ids.length} ап. до ${clock(e.end_step)}`}
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}</div>
      {sub && <div className="kpi-sub muted">{sub}</div>}
    </div>
  );
}
