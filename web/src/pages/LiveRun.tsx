import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { advanceUntil, api } from "../api/client";
import { store } from "../api/store";
import type { Algorithm, EventRecord, Goal, Impact, JobView, RunRecord, RunView, Timeline } from "../api/types";
import ImpactCard from "../features/ImpactCard";
import ChatWidget from "../components/ChatWidget";
import ForecastCard from "../features/ForecastCard";
import ReportModal from "../features/ReportModal";
import Research from "../features/Research";
import EventComposer from "../components/EventComposer";
import RunDashboard from "../components/RunDashboard";
import RunSkeleton from "../components/RunSkeleton";
import { fromTimeline } from "../lib/cells";
import { ALGO, GOAL, clock } from "../format";
import { Term } from "../glossary";

// Живой запуск: запись хранится в браузере, сервер пересчитывает по ней и возвращает новую.
export default function LiveRun() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [view, setView] = useState<RunView | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [target, setTarget] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"control" | "event">("control");
  const [report, setReport] = useState(false);
  const [intervention, setIntervention] = useState<{ event: Record<string, unknown>; impact?: Impact; error?: string; sent?: string | null } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const suggestions = useMemo<EventRecord[]>(() => {
    try { return JSON.parse(localStorage.getItem(`sz_suggest_${id}`) ?? "[]"); } catch { return []; }
  }, [id]);

  const refresh = useCallback(async (r: RunRecord, v?: RunView) => {
    const [vv, jj, tt] = await Promise.all([v ? Promise.resolve(v) : api.view(r), api.jobs(r), api.timeline(r)]);
    setView(vv); setJobs(jj); setTimeline(tt);
  }, []);

  useEffect(() => {
    store.all().then(async (all) => {
      const r = all.find((x) => x.id === id);
      if (!r) { setError("Смена не найдена в этом браузере"); return; }
      setRun(r); setTarget(Math.min(r.steps_executed + 12, 288));
      try { await refresh(r); } catch (e) { setError((e as Error).message); }
    });
  }, [id, refresh]);

  const save = async (r: RunRecord, v: RunView) => { setRun(r); await store.save(r); await refresh(r, v); };

  const go = async (until: number) => {
    if (!run) return;
    setBusy("Расчёт…"); setError(null);
    abort.current = new AbortController();
    try {
      const res = await advanceUntil(run, until, (p) => {
        setBusy(`Расчёт: шаг ${p.run.steps_executed} из ${until}`);
        setRun(p.run); setView(p.view); store.save(p.run);
      }, abort.current.signal);
      await save(res.run, res.view);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const sendEvent = async (event: unknown): Promise<string | null> => {
    if (!run) return "Нет запуска";
    setBusy("Проверка сообщения…");
    try {
      const res = await api.event(run, event);
      await save(res.run, res.view);   // отказ тоже сохраняется в журнале отклонённых
      return res.error ?? null;
    } catch (e) { return (e as Error).message; } finally { setBusy(null); }
  };

  const changeGoal = async (g: Goal) => {
    if (!run) return;
    setBusy("Смена цели…");
    try { const res = await api.setGoal(run, g); await save(res.run, res.view); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const fork = async (g?: Goal, a?: Algorithm) => {
    if (!run) return;
    setBusy("Создание ветви…");
    try {
      const res = await api.fork(run, g, a);
      await store.save(res.run);
      nav(`/console/run/${res.run.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const download = async () => {
    if (!run) return;
    setBusy("Выгрузка…");
    try {
      const data = await api.export(run);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: `sozvezdie_${run.id.slice(0, 8)}_step${run.steps_executed}.json` }).click();
      URL.revokeObjectURL(url);
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };

  const board = useMemo(() => (timeline ? fromTimeline(timeline) : null), [timeline]);
  const explain = useCallback((jobId: string) => api.explain(run!, { job_id: jobId }), [run]);
  const whyNot = useCallback((jobId: string) => api.f.whyNot(run!, jobId), [run]);
  const passport = useCallback((sid: string) => api.f.passport(run!, sid), [run]);

  // п.8: вмешательство прямо с карты — сначала цена (3 ветви), потом решение оператора.
  const intervene = useCallback((sid: string, kind: "satellite_outage" | "close_downlink") => {
    if (!run || !view) return;
    const k0 = run.steps_executed;
    let n = view.events.length + 1;
    while (view.events.some((e) => e.id === `OP-${n}`)) n++;
    const event = { id: `OP-${n}`, at_step: k0, type: kind, satellite_ids: [sid], end_step: Math.min(k0 + 12, view.steps_total) };
    setIntervention({ event });
    api.f.impact(run, event).then((impact) => setIntervention({ event, impact })).catch((e) => setIntervention({ event, error: e.message }));
  }, [run, view]);

  // п.10: ссылка на момент — только для демо-смены: её любой может пересоздать по той же ссылке.
  const shareUrl = useCallback((step: number, sid?: string) => {
    let demoId: string | null = null;
    try { demoId = localStorage.getItem("sz_demo_run_v2"); } catch { /* нет хранилища */ }
    // Демо пересоздаётся остановленным в 12:00 (шаг 144, server/main.py DEMO_STOP) — ссылка только до этого момента.
    if (!run || run.id !== demoId || step >= 144) return null;
    const q = new URLSearchParams({ t: String(step) });
    if (sid) q.set("sat", sid);
    return `${window.location.origin}/console/demo?${q}`;
  }, [run]);

  if (error && !view) return <p className="error">{error}</p>;
  if (!run || !view || !board) return <RunSkeleton />;
  const total = view.steps_total, k = run.steps_executed, done = k >= total;

  const side = (<>
    <section className="card control">
      <div className="filters">
        <button className={"chip" + (tab === "control" ? " on" : "")} onClick={() => setTab("control")}>Управление</button>
        <button className={"chip" + (tab === "event" ? " on" : "")} disabled={done} onClick={() => setTab("event")}>Сообщение</button>
      </div>
      {tab === "control" ? (
        <>
          {done && <p className="note">Смена завершена — доступны выгрузка и сравнение. Для другого варианта создайте <Link className="id" to="/console/new">новую смену</Link>.</p>}
          {!done && suggestions.some((e) => e.at_step >= k && !view.events.some((x) => x.id === e.id)) && (
            <button className="note note-action" onClick={() => setTab("event")}>
              Есть сообщение из примера организаторов на {clock(Math.min(...suggestions.filter((e) => e.at_step >= k).map((e) => e.at_step)))} — открыть →
            </button>
          )}
          <div className="row"><button className="btn" disabled={!!busy || done} onClick={() => go(k + 1)}>+1 шаг</button>
            <button className="btn" disabled={!!busy || done} onClick={() => go(Math.min(k + 12, total))}>+1 час</button>
            <button className="btn" disabled={!!busy || done} onClick={() => go(total)}>До конца</button></div>
          <div className="row">
            <input className="input mono" type="number" min={k + 1} max={total} value={target} onChange={(e) => setTarget(+e.target.value)} />
            <button className="btn" disabled={!!busy || done || target <= k} onClick={() => go(target)}>Остановиться перед шагом {target} ({clock(target)})</button>
          </div>
          {busy && <p className="mono small warn-text">{busy} {abort.current && <button className="btn" onClick={() => abort.current?.abort()}>Стоп</button>}</p>}
          {error && <p className="error">{error}</p>}
          <h4>Цель управления</h4>
          <div className="row">
            {(["priority", "revenue"] as Goal[]).map((g) => (
              <button key={g} className={"chip" + (view.goal === g ? " on" : "")} disabled={!!busy || done || view.goal === g}
                onClick={() => changeGoal(g)}>{GOAL[g]}</button>
            ))}
          </div>
          {view.goal_history.length > 1 && <p className="muted small mono">{view.goal_history.map((h) => `${clock(h.step)} → ${GOAL[h.goal]}`).join(" · ")}</p>}
          <h4>Вариант продолжения из этого состояния</h4>
          <div className="row">
            <button className="btn" disabled={!!busy || done} onClick={() => fork(view.goal === "priority" ? "revenue" : "priority")}>Ветвь с другой целью</button>
            <button className="btn" disabled={!!busy || done} onClick={() => fork(undefined, view.algorithm.name === "horizon-cpsat" ? "edf-baseline" : "horizon-cpsat")}>Ветвь с другим алгоритмом</button>
          </div>
          <h4>Результат</h4>
          <div className="row"><button className="btn" disabled={!!busy} onClick={download}>Скачать выгрузку JSON</button>
            <button className="btn" onClick={() => nav(`/console/compare?a=${run.id}`)}>Сравнить…</button></div>
          <div className="row"><button className="btn" disabled={k === 0} onClick={() => setReport(true)}>Отчёт о передаче смены</button></div>
        </>
      ) : (
        <EventComposer run={run} suggestions={suggestions} step={k} steps={total} satellites={board.satellites} busy={!!busy}
          usedIds={[...view.events.map((e) => e.id)]} onSend={sendEvent} />
      )}
    </section>
    <ForecastCard run={run} />
  </>);

  return (
    <>
      <div className="run-head">
        <div className="bar-info">
          <span className="id">{"ref" in run.scenario ? run.scenario.ref : "свой сценарий"}</span>
          <span className="muted">{GOAL[view.goal]}</span>
          <span className="muted">{ALGO[view.algorithm.name]}</span>
          {view.parent && <span className="tag">ветвь от {view.parent.run_id.slice(0, 8)} с шага {view.parent.fork_step}</span>}
        </div>
        <div className="bar-step mono">{clock(k)} · <Term k="step">шаг</Term> {k} из {total}{done ? " · смена завершена" : ""}</div>
      </div>
      <RunDashboard view={view} jobs={jobs} board={board} explain={explain} side={side}
        after={k > 0 ? <Research run={run} /> : undefined}
        whyNot={whyNot} passport={passport} shareUrl={shareUrl}
        onIntervene={done ? undefined : intervene} interveneStep={done ? undefined : k} />
      {intervention && (
        <div className="modal-back" onClick={() => setIntervention(null)}>
          <div className="modal" role="dialog" aria-label="Цена вмешательства" onClick={(e) => e.stopPropagation()}>
            <header><b>{intervention.event.type === "satellite_outage" ? "Отключить" : "Отменить связь с Землёй у"} {(intervention.event.satellite_ids as string[])[0]} с {clock(k)} до {clock(intervention.event.end_step as number)}</b>
              <button className="icon-btn" onClick={() => setIntervention(null)} aria-label="Закрыть">×</button></header>
            <div className="modal-body">
              {!intervention.impact && !intervention.error && <><p className="muted small">Считаю три продолжения из текущего состояния моделью организаторов…</p><div className="skeleton tall" /></>}
              {intervention.error && <p className="error">{intervention.error}</p>}
              {intervention.impact && <ImpactCard r={intervention.impact} />}
              {intervention.sent === null && <p className="ok-text">Сообщение принято — план перестроен с {clock(k)}.</p>}
              {intervention.sent && <p className="error">{intervention.sent}</p>}
            </div>
            <footer>
              <button className="btn" onClick={() => setIntervention(null)}>Не отправлять</button>
              <button className="btn btn-primary" disabled={!intervention.impact || intervention.sent === null || !!busy}
                onClick={async () => { const err = await sendEvent(intervention.event); setIntervention((x) => x && { ...x, sent: err }); }}>Отправить как сообщение</button>
            </footer>
          </div>
        </div>
      )}
      {report && <ReportModal run={run} onClose={() => setReport(false)} />}
      {k > 0 && <ChatWidget run={run} />}
    </>
  );
}
