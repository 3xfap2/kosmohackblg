import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Term } from "../glossary";
import { ALGO, GOAL, usd } from "../format";

// Все прогоны генератора experiments/run.py. Числа только из /api/results (results/summary.json) — в тексте их нет.
interface Row {
  key: string; scenario: string; algorithm: string; goal: "priority" | "revenue";
  p3_done: number; p3_due: number; jobs_done: number; jobs_total: number; revenue_usd: number;
  blocked: number; min_soc_pct: number; replay_match?: boolean; repeat_match?: boolean;
  solves: number; cpsat_selected: number; guard: number; fallback: number; seconds?: number | null;
}
const SCEN: Record<string, [string, string]> = {
  P01_intro: ["Вводный пример", "маленькая смена для проверки правил модели"],
  P02_shift: ["Обычная смена", "сутки работы группировки"],
  P03_energy: ["Дефицит энергии", "та же смена, батареи слабее"],
  P04_demand: ["Перегрузка заданиями", "заданий больше, чем группировка успевает"],
};
const ORDER = ["edf-baseline", "goal-greedy", "horizon-cpsat"];
const sec = (s?: number | null) => (s == null ? "—" : s < 1 ? "< 1 с" : `${s.toFixed(s < 10 ? 1 : 0).replace(".", ",")} с`);
const signed = (x: number, f: (v: number) => string = String) => (x > 0 ? "+" : x < 0 ? "−" : "±") + f(Math.abs(x));

export default function Results() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState<"priority" | "revenue">("priority");
  useEffect(() => {
    fetch("/api/results").then((r) => r.json())
      .then((d) => (d.available ? setRows(d.runs) : setError("Результаты ещё не сгенерированы.")))
      .catch((e) => setError(String(e)));
  }, []);

  const plain = (rows ?? []).filter((r) => !r.key.includes("_events__"));
  const scenarios = Object.keys(SCEN).filter((s) => plain.some((r) => r.scenario === s));
  const events = (rows ?? []).filter((r) => r.key.includes("_events__") && r.goal === goal);
  const frozen = events.find((r) => r.key.includes("__frozen__")), adaptive = events.find((r) => r.key.includes("__adaptive__"));
  const hybrid = plain.filter((r) => r.algorithm === "horizon-cpsat" && r.goal === goal);
  const replayOk = (rows ?? []).filter((r) => r.replay_match).length, repeatOk = (rows ?? []).filter((r) => r.repeat_match).length;
  // Главный показатель цели: для приоритета — срочные в срок, для коммерции — выручка.
  const main = (r: Row) => (goal === "priority" ? r.p3_done : r.revenue_usd);

  return (
    <div className="setup">
      <div className="page-head">
        <div>
          <h1>Результаты</h1>
          <p className="muted small">Каждая смена рассчитана тремя алгоритмами, исполнена <Term k="model">моделью организаторов</Term> и повторена.
            Сравнивайте с простым правилом: оно показывает, сколько даёт планирование.</p>
        </div>
        <div className="seg" role="tablist">
          {(["priority", "revenue"] as const).map((g) => (
            <button key={g} role="tab" aria-selected={goal === g} className={goal === g ? "on" : ""} onClick={() => setGoal(g)}>{GOAL[g]}</button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!rows && !error && <div className="skeleton tall" />}

      {rows && (
        <>
          <div className="checks">
            <span><b className="ok-text">✓ {replayOk} из {rows.length}</b> прогонов повторены моделью организаторов с тем же итогом</span>
            <span><b className="ok-text">✓ {repeatOk} из {rows.length}</b> рассчитаны дважды — команды совпали побитно</span>
            <span className="muted">источник: <a className="id" href="/api/results" target="_blank" rel="noreferrer">results/summary.json</a></span>
          </div>

          {scenarios.map((s) => {
            const list = ORDER.map((a) => plain.find((r) => r.scenario === s && r.algorithm === a && r.goal === goal)).filter(Boolean) as Row[];
            const base = list.find((r) => r.algorithm === "edf-baseline");
            const best = Math.max(...list.map(main));
            return (
              <section key={s} className="card">
                <div className="card-head">
                  <h2>{SCEN[s][0]} <span className="muted small mono">· {s}</span></h2>
                  <span className="muted small">{SCEN[s][1]}</span>
                </div>
                <div className="table-scroll">
                  <table className="table res-table">
                    <thead><tr>
                      <th>Алгоритм</th>
                      <th className={goal === "priority" ? "hl" : ""}><Term k="p3">Срочные в срок</Term></th>
                      <th>Выполнено заданий</th>
                      <th className={goal === "revenue" ? "hl" : ""}>Выручка</th>
                      <th><Term k="reserve">Мин. заряд</Term></th>
                      <th>Отказов модели</th>
                      <th>Расчёт</th>
                      <th>Проверка</th>
                    </tr></thead>
                    <tbody>
                      {list.map((r) => {
                        const d = base && r !== base ? main(r) - main(base) : null;
                        return (
                          <tr key={r.key} className={r === base ? "base" : ""}>
                            <td>{ALGO[r.algorithm]}{main(r) === best && list.length > 1 && main(r) !== main(base!) && <span className="pill ok">лучший</span>}</td>
                            <td className={"mono" + (goal === "priority" ? " hl" : "")}>{r.p3_done} / {r.p3_due}
                              {goal === "priority" && d != null && <div className={"tiny " + (d > 0 ? "ok-text" : d < 0 ? "warn-text" : "muted")}>{signed(d)} к правилу</div>}
                            </td>
                            <td className="mono">{r.jobs_done} / {r.jobs_total}</td>
                            <td className={"mono" + (goal === "revenue" ? " hl" : "")}>{usd(r.revenue_usd)}
                              {goal === "revenue" && d != null && <div className={"tiny " + (d > 0 ? "ok-text" : d < 0 ? "warn-text" : "muted")}>{signed(d, usd)} к правилу</div>}
                            </td>
                            <td className="mono">{r.min_soc_pct.toFixed(1)}%</td>
                            <td className="mono">{r.blocked}</td>
                            <td className="mono">{sec(r.seconds)}</td>
                            <td className="mono">{r.replay_match ? <span className="ok-text">✓ повтор</span> : <span className="error">✗ повтор</span>}
                              {" "}{r.repeat_match ? <span className="ok-text">✓ дважды</span> : <span className="error">✗ дважды</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          {frozen && adaptive && (
            <section className="card">
              <div className="card-head"><h2>Сообщения во время смены</h2><span className="muted small">Обычная смена + пример сообщений организаторов</span></div>
              <p className="muted small">Срочные заявки, отказы спутников, отмена сеанса связи. «Старый план» продолжает исполнять то, что было до сообщения;
                «с перестройкой» — план пересчитывается после каждого сообщения.</p>
              <div className="duel">
                <div><span className="muted tiny">старый план</span><b className="mono dim">{goal === "priority" ? `${frozen.p3_done} / ${frozen.p3_due}` : usd(frozen.revenue_usd)}</b></div>
                <i>→</i>
                <div><span className="muted tiny">с перестройкой</span><b className="mono">{goal === "priority" ? `${adaptive.p3_done} / ${adaptive.p3_due}` : usd(adaptive.revenue_usd)}</b></div>
                <div className="duel-side muted small mono">
                  выполнено {frozen.jobs_done} → {adaptive.jobs_done}<br />
                  {goal === "priority" ? `выручка ${usd(frozen.revenue_usd)} → ${usd(adaptive.revenue_usd)}` : `срочные ${frozen.p3_done} → ${adaptive.p3_done}`}
                </div>
              </div>
            </section>
          )}

          {hybrid.length > 0 && (
            <section className="card">
              <div className="card-head"><h2>Как часто CP-SAT улучшает план эвристики</h2></div>
              <p className="muted small">На каждой перестройке решатель ищет план на 4 часа вперёд. Его план проверяется моделью организаторов
                и принимается, только если он лучше плана эвристики на том же окне; иначе остаётся эвристика. Честно: чаще остаётся эвристика.</p>
              <div className="solver-grid">
                {hybrid.map((r) => (
                  <div key={r.key} className="solver">
                    <span className="small">{SCEN[r.scenario]?.[0] ?? r.scenario}</span>
                    <div className="mini-bar"><i style={{ width: `${r.solves ? (r.cpsat_selected / r.solves) * 100 : 0}%` }} /></div>
                    <span className="mono small">CP-SAT принят в {r.cpsat_selected} из {r.solves}{r.fallback ? ` · запасной режим ${r.fallback}` : ""}</span>
                  </div>
                ))}
              </div>
              <p className="muted small">Подробнее — <Link className="id" to="/console/method">как это работает</Link>.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
