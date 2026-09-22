import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { store } from "../api/store";
import type { Algorithm, Goal, Overrides, RunRecord, ScenarioInfo, ScenarioSource } from "../api/types";
import { ALGO, GOAL, clock } from "../format";

// Настройка смены: сценарий (встроенный или свой файл), изменённые условия, цель и алгоритм.
export default function Setup() {
  const nav = useNavigate();
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [source, setSource] = useState<ScenarioSource | null>(null);
  const [info, setInfo] = useState<ScenarioInfo | null>(null);
  const [goal, setGoal] = useState<Goal>("priority");
  const [algorithm, setAlgorithm] = useState<Algorithm>("horizon-cpsat");
  const [solar, setSolar] = useState("");
  const [socSat, setSocSat] = useState("");
  const [socVal, setSocVal] = useState("");
  const [prioJob, setPrioJob] = useState("");
  const [prioVal, setPrioVal] = useState<1 | 2 | 3>(3);
  const [outSat, setOutSat] = useState("");
  const [outFrom, setOutFrom] = useState("");
  const [outTo, setOutTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.scenarios().then((list) => { setScenarios(list); if (list.some((x) => x.id === "P02_shift")) pick({ ref: "P02_shift" }); })
      .catch((e) => setError(`Сервер недоступен: ${e.message}`));
    store.all().then((r) => setRuns(r.sort((a, b) => a.id.localeCompare(b.id))));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const overrides = (): Overrides | undefined => {
    const o: Overrides = {};
    if (solar) o.solar_factor = Number(solar);
    if (socSat && socVal) o.initial_soc_pct = { [socSat]: Number(socVal) };
    if (prioJob) o.job_priority = { [prioJob]: prioVal };
    if (outSat && outFrom && outTo) o.failures = [{ satellite_id: outSat, start_step: Number(outFrom), end_step: Number(outTo) }];
    return Object.keys(o).length ? o : undefined;
  };

  const pick = async (src: ScenarioSource) => {
    setError(null); setSource(src); setInfo(null);
    try { setInfo(await api.inspect(src)); } catch (e) { setError((e as Error).message); setSource(null); }
  };

  const applyOverrides = async () => {
    if (!source) return;
    const o = overrides();
    await pick({ ...source, overrides: o } as ScenarioSource);
  };

  const create = async () => {
    if (!source) return;
    setBusy(true); setError(null);
    try {
      const o = overrides();   // введённые условия не теряются, даже если «Применить» не нажали
      const res = await api.create(o ? ({ ...source, overrides: o } as ScenarioSource) : source, goal, algorithm);
      await store.save(res.run);
      nav(`/console/run/${res.run.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="setup">
      <h1>Новая смена</h1>
      {error && <p className="error">{error}</p>}

      <section className="card">
        <h2><span className="step-no">01</span>Сценарий</h2>
        <div className="scenario-list">
          {scenarios?.map((s) => (
            <button key={s.id} className={"scenario spot" + (source && "ref" in source && source.ref === s.id ? " on" : "")}
              onClick={() => pick({ ref: s.id })}>
              <span className="id small">{s.id}</span>
              <span className="scenario-title">{s.title}</span>
              <span className="scenario-meta">
                <span>{s.satellites} аппаратов</span><span>{clock(s.steps)}</span><span>{s.jobs} заданий</span>
              </span>
            </button>
          ))}
          <label className="scenario upload spot">
            <span className="scenario-title">+ Свой сценарий</span>
            <span className="muted small">формат cosmo-B-ops-1.0, проверяется моделью</span>
            <input type="file" accept=".json,application/json" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              try { await pick({ inline: JSON.parse(await f.text()) }); } catch (err) { setError(`Файл не читается: ${(err as Error).message}`); }
            }} />
          </label>
        </div>
        {info && (
          <p className="mono small">
            <span className="ok-text">✓</span> проверено моделью: {info.steps} шагов, {info.jobs} заданий (P3 — {info.jobs_by_priority["3"]},
            на Землю — {info.jobs_by_kind.downlink}); доказуемо невыполнимых: {info.provably_infeasible_jobs}
          </p>
        )}
      </section>

      <section className="card">
        <h2><span className="step-no">02</span>Условия эксперимента <span className="muted small">— необязательно, создаёт отдельный сценарий</span></h2>
        <div className="form-row">
          <label className="field">Солнечная мощность, множитель
            <input className="input mono" placeholder="1.0" value={solar} onChange={(e) => setSolar(e.target.value)} /></label>
          <label className="field">Начальный заряд аппарата
            <span className="pair">
              <input className="input mono" placeholder="S01" value={socSat} onChange={(e) => setSocSat(e.target.value)} />
              <input className="input mono" placeholder="%" value={socVal} onChange={(e) => setSocVal(e.target.value)} />
            </span></label>
          <label className="field">Приоритет задания
            <span className="pair">
              <input className="input mono" placeholder="JOB-0001" value={prioJob} onChange={(e) => setPrioJob(e.target.value)} />
              <select className="select mono" value={prioVal} onChange={(e) => setPrioVal(+e.target.value as 1 | 2 | 3)}>
                <option value={3}>3</option><option value={2}>2</option><option value={1}>1</option>
              </select>
            </span></label>
          <label className="field">Недоступность аппарата, шаги [с, по)
            <span className="pair">
              <input className="input mono" placeholder="S08" value={outSat} onChange={(e) => setOutSat(e.target.value)} />
              <input className="input mono" placeholder="60" value={outFrom} onChange={(e) => setOutFrom(e.target.value)} />
              <input className="input mono" placeholder="120" value={outTo} onChange={(e) => setOutTo(e.target.value)} />
            </span></label>
        </div>
        <button className="btn" disabled={!source} onClick={applyOverrides}>Применить условия</button>
      </section>

      <section className="card">
        <h2><span className="step-no">03</span>Цель и алгоритм</h2>
        <div className="form-row">
          {(["priority", "revenue"] as Goal[]).map((g) => (
            <button key={g} className={"choice spot" + (goal === g ? " on" : "")} onClick={() => setGoal(g)}>
              <b>{GOAL[g]}</b>
              <span className="muted small">{g === "priority" ? "Сначала задания приоритета 3 в срок, затем выручка" : "Максимум выручки; приоритет 3 показывается отдельно"}</span>
            </button>
          ))}
        </div>
        <div className="form-row">
          {(["horizon-cpsat", "goal-greedy", "edf-baseline"] as Algorithm[]).map((a) => (
            <button key={a} className={"choice spot" + (algorithm === a ? " on" : "")} onClick={() => setAlgorithm(a)}>
              {a === "horizon-cpsat" && <span className="badge">основной</span>}
              <b>{ALGO[a]}</b>
              <span className="muted small">{a === "horizon-cpsat" ? "Основной: эвристика + CP-SAT на 4 часа вперёд; план CP-SAT принимается, только если модель подтверждает, что он не хуже" : a === "goal-greedy" ? "Быстрая: порядок по цели, отсечка безнадёжных, калибровка заранее" : "Простое правило для сравнения: ближайший срок"}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-primary" disabled={!info || busy} onClick={create}>{busy ? "Создание…" : <>Создать смену <span className="arrow">→</span></>}</button>
      </section>

      <section className="card">
        <h2>Мои смены <span className="muted small">— хранятся в этом браузере</span></h2>
        {runs.length === 0 && <p className="muted small">Пока нет. Или откройте <Link to="/console" className="id">демо-смену</Link>.</p>}
        <ul className="run-list">
          {runs.map((r) => (
            <li key={r.id}>
              <Link to={`/console/run/${r.id}`}><span className="id">{r.id.slice(0, 8)}</span></Link>
              <span className="mono small">{"ref" in r.scenario ? r.scenario.ref : "свой сценарий"}</span>
              <span className="muted small">{GOAL[r.run_metadata.goal]} · {ALGO[r.run_metadata.algorithm]}</span>
              <span className="mono small">шаг {r.steps_executed}</span>
              {r.run_metadata.parent && <span className="tag">ветвь от {r.run_metadata.parent.run_id.slice(0, 8)} @ {r.run_metadata.parent.fork_step}</span>}
              <button className="btn" onClick={async () => { await store.remove(r.id); setRuns((x) => x.filter((y) => y.id !== r.id)); }}>Удалить</button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
