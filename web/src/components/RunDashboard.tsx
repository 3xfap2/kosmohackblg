import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Explanation, JobView, Passport, RunView, WhyNot } from "../api/types";
import type { Board } from "../lib/cells";
import { EVENT_TYPE, clock, pct, usd } from "../format";
import { Term } from "../glossary";
import ExplainPanel from "./ExplainPanel";
import Gantt from "./Gantt";
import JobsTable from "./JobsTable";
import OrbitView from "./OrbitView";
import SocChart from "./SocChart";

// Общая панель смены: одинаково для демо и живого запуска. Все числа — из RunView ядра.
export default function RunDashboard({ view: v, jobs, board, explain, initialStep, side, after, whyNot, passport, onIntervene, interveneStep, shareUrl, seek }: {
  view: RunView; jobs: JobView[]; board: Board;
  explain: (jobId: string) => Promise<Explanation>;
  initialStep?: number; side?: ReactNode; after?: ReactNode;
  whyNot?: (jobId: string) => Promise<WhyNot>; passport?: (sid: string) => Promise<Passport>;
  onIntervene?: (sid: string, kind: "satellite_outage" | "close_downlink") => void; interveneStep?: number;
  shareUrl?: (step: number, sid?: string) => string | null;
  seek?: { step: number; n: number };
}) {
  const params = new URLSearchParams(window.location.search);
  const urlSat = params.get("sat"), urlT = params.get("t");
  const [sat, setSat] = useState(urlSat && board.satellites.includes(urlSat) ? urlSat : board.satellites[0] ?? "S01");
  const [cursor, setCursor] = useState(initialStep ?? (urlT != null ? Math.min(Number(urlT) || 0, Math.max(board.executed - 1, 0)) : Math.max(board.executed - 1, 0)));
  const [picked, setPicked] = useState<string | undefined>();
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const s = v.summary;

  // Курсор следует за расчётом, пока смена идёт.
  const first = useRef(true);
  useEffect(() => { if (first.current && urlT != null) { first.current = false; return; } first.current = false; setCursor(Math.max(board.executed - 1, 0)); }, [board.executed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!picked && jobs.length) setPicked(jobs.find((j) => j.status === "missed")?.id);
  }, [jobs, picked]);
  useEffect(() => {
    if (!picked) { setExplanation(null); return; }
    let live = true;
    explain(picked).then((e) => live && setExplanation(e)).catch((e) => live && setExplanation({
      subject: { job_id: picked }, known_at_decision: [], constraint: null, consequence: `Не удалось получить объяснение: ${e.message}`,
    }));
    return () => { live = false; };
  }, [picked, explain]);

  useEffect(() => {
    if (!seek) return;
    setCursor(Math.min(seek.step, Math.max(board.executed - 1, 0)));
    document.getElementById("map")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [seek]); // eslint-disable-line react-hooks/exhaustive-deps

  const satCells = useMemo(() => board.cells.filter((c) => c.satellite_id === sat), [board, sat]);

  return (
    <>
      <section className="kpis">
        <Kpi label={<><Term k="p3">Приоритет 3</Term> в срок</>} value={`${s.critical_jobs_completed_on_time} / ${s.critical_jobs_due}`} sub={pct(v.kpi.p3_on_time_share)} />
        <Kpi label="Выполнено заданий" value={`${s.jobs_completed} / ${s.jobs_total}`} sub={`просрочено ${s.jobs_due_missed}`} />
        <Kpi label={<Term k="revenue">Выручка смены</Term>} value={usd(s.revenue_usd)} sub={`упущено ${usd(v.kpi.revenue_lost_in_missed_usd)}`} />
        <Kpi label="Минимальный заряд" value={`${s.minimum_soc_pct.toFixed(1)}%`} sub={<>ниже <Term k="reserve">резерва</Term>: {s.below_reserve_satellite_steps} <Term k="satsteps">ап.-шагов</Term></>} />
        <Kpi label={<><Term k="blocked">Отклонено</Term> <Term k="model">моделью</Term></>} value={String(s.blocked_command_count)} sub="команд" />
        <Kpi label={<Term k="utilization">Загрузка аппаратов</Term>} value={pct(v.kpi.utilization)} sub="доля шагов с заданием" />
      </section>

      <div className="layout">
        <main>
          <section className="card" id="map">
            <div className="card-head"><h2>Группировка в момент {clock(cursor)}</h2></div>
            <OrbitView board={board} events={v.events} step={cursor} onStep={setCursor} selected={sat} onSelect={setSat} passport={passport}
              onIntervene={onIntervene} interveneStep={interveneStep} shareUrl={shareUrl} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Подробное расписание</h2>
              <div className="legend mono">
                <i style={{ background: "var(--relay)" }} /><Term k="relay">ретрансляция</Term>
                <i style={{ background: "var(--info)" }} /><Term k="downlink">на Землю</Term>
                <i style={{ background: "var(--warn)" }} /><Term k="calibration">калибровка</Term>
                <i style={{ background: "var(--surface)", border: "1px solid var(--line)" }} /><Term k="shadow">тень</Term>
                <i style={{ background: "var(--bad)" }} />отказ
              </div>
            </div>
            <p className="muted small">Строка — спутник, столбец — 5 минут. Пунктир — момент, показанный на орбите. Нажмите на ячейку, чтобы перейти к ней.</p>
            <Gantt board={board} cursor={cursor} selected={sat} onSelect={(sid, k) => { setSat(sid); setCursor(k); }} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Заряд аппарата <span className="id">{sat}</span></h2>
              <select value={sat} onChange={(e) => setSat(e.target.value)} className="select mono">
                {board.satellites.map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <SocChart cells={satCells} dark={board.dark[sat] ?? ""} steps={board.steps} />
            <p className="muted small">Пунктир: жёлтый — резерв 30 % (ниже него задания и калибровка не допускаются), красный — критический 20 %.</p>
          </section>

          <section className="card" id="jobs">
            <div className="card-head"><h2>Задания</h2></div>
            <JobsTable jobs={jobs} onPick={setPicked} picked={picked} />
          </section>
          {after}
        </main>

        <aside>
          {side}
          <section className="card">
            <h2>Почему?</h2>
            <ExplainPanel e={explanation} whyNot={whyNot} missed={jobs.find((j) => j.id === picked)?.status === "missed"} />
          </section>
          <section className="card">
            <h2>Сообщения смены</h2>
            {v.events.length === 0 && <p className="muted small">Сообщений пока нет.</p>}
            <ol className="events">
              {v.events.map((e) => (
                <li key={e.id}>
                  <span className="mono muted">{clock(e.at_step)}</span> <span className="id">{e.id}</span>{" "}
                  {e.type === "add_jobs" ? `${EVENT_TYPE.add_jobs}: ${e.jobs.map((j) => j.id).join(", ")}`
                    : e.type === "satellite_outage" ? `недоступны ${e.satellite_ids.join(", ")} до ${clock(e.end_step)}`
                    : `отмена сеансов: ${e.satellite_ids.length} ап. до ${clock(e.end_step)}`}
                </li>
              ))}
            </ol>
            {v.rejected_events.length > 0 && (
              <>
                <h4>Отклонённые</h4>
                <ul className="events">
                  {v.rejected_events.map((r, i) => (
                    <li key={i} className="error">{clock(r.received_at_step)} · {r.error}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function Kpi({ label, value, sub }: { label: ReactNode; value: string; sub?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}</div>
      {sub && <div className="kpi-sub muted">{sub}</div>}
    </div>
  );
}
