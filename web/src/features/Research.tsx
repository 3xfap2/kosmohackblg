import { useState } from "react";
import { api } from "../api/client";
import type { Algorithm, Frontier, Goal, Link, RunRecord, Stress, Tournament, WhatIf } from "../api/types";
import { ALGO, GOAL, clock, usd } from "../format";

// F5–F8: исследования смены. Каждое число — полный прогон модели организаторов.
type Tab = "tournament" | "whatif" | "frontier" | "stress" | "link";
const TABS: [Tab, string, string][] = [
  ["tournament", "Турнир стратегий", "Из этого момента до конца смены: простое правило и эвристика с обеими целями, одинаковые условия. Какая стратегия лучше для каждой цели."],
  ["whatif", "Что если добавить ресурс", "Какой ресурс даст больше: +10% солнца, ещё канал на Землю или ёмкие батареи."],
  ["frontier", "Приоритет ↔ выручка", "Сколько выручки стоит каждое спасённое срочное задание."],
  ["stress", "Устойчивость", "12 случайных наборов отказов: наш планировщик против простого правила."],
  ["link", "Связь с Землёй", "Есть ли моменты, когда ни один аппарат не может передать данные."],
];
const sign = (x: number, f: (v: number) => string = String) => (x > 0 ? "+" : x < 0 ? "−" : "±") + f(Math.abs(x));

export default function Research({ run, onFork }: { run: RunRecord; onFork?: (goal: Goal, algorithm: Algorithm) => void }) {
  const [tab, setTab] = useState<Tab>("tournament");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{ tournament?: Tournament; whatif?: WhatIf; frontier?: Frontier; stress?: Stress; link?: Link }>({});

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = tab === "tournament" ? await api.f.tournament(run) : tab === "whatif" ? await api.f.whatIf(run) : tab === "frontier" ? await api.f.frontier(run)
        : tab === "stress" ? await api.f.stress(run) : await api.f.link(run);
      setData((d) => ({ ...d, [tab]: r }));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const current = TABS.find((t) => t[0] === tab)!;

  return (
    <section className="card">
      <div className="card-head"><h2>Исследование смены</h2></div>
      <div className="filters">
        {TABS.map(([id, title]) => (
          <button key={id} className={"chip" + (tab === id ? " on" : "")} onClick={() => { setTab(id); setError(null); }}>{title}</button>
        ))}
      </div>
      <div className="research-head">
        <p className="muted small">{current[2]}</p>
        <button className="btn" disabled={busy} onClick={go}>{busy ? "Считаю…" : data[tab] ? "Пересчитать" : "Рассчитать"}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {busy && <div className="skeleton" />}
      {!busy && tab === "tournament" && data.tournament && <TournamentView r={data.tournament} onFork={onFork} />}
      {!busy && tab === "whatif" && data.whatif && <WhatIfView r={data.whatif} />}
      {!busy && tab === "frontier" && data.frontier && <FrontierView r={data.frontier} />}
      {!busy && tab === "stress" && data.stress && <StressView r={data.stress} />}
      {!busy && tab === "link" && data.link && <LinkView r={data.link} />}
    </section>
  );
}

function TournamentView({ r, onFork }: { r: Tournament; onFork?: (goal: Goal, algorithm: Algorithm) => void }) {
  const isBest = (g: Goal, row: Tournament["rows"][number]) => r.best[g].algorithm === row.algorithm && r.best[g].goal === row.goal;
  const name = (x: { algorithm: Algorithm; goal: Goal }) => `${ALGO[x.algorithm]} · ${GOAL[x.goal].toLowerCase()}`;
  const bp = r.rows.find((x) => isBest("priority", x))!, br = r.rows.find((x) => isBest("revenue", x))!;
  return (
    <>
      <p className="finding">Для приоритетного обслуживания лучше «{name(bp)}» — {bp.p3_done} из {bp.p3_due} срочных;
        для коммерческой отдачи — «{name(br)}» — {usd(br.revenue_usd)}.</p>
      <div className="table-scroll">
        <table className="table res-table">
          <thead><tr><th>Стратегия</th><th>Срочные в срок</th><th>Выполнено</th><th>Выручка</th><th>Ниже резерва, ап.-шагов</th><th>Заряд в конце</th><th /></tr></thead>
          <tbody>
            {r.rows.map((row) => (
              <tr key={row.algorithm + row.goal} className={row.current ? "picked" : ""}>
                <td>{ALGO[row.algorithm]}<div className="muted tiny">{GOAL[row.goal]}{row.current ? " · текущая" : ""}</div>
                  {isBest("priority", row) && <span className="pill ok">лучшая по срочным</span>}
                  {isBest("revenue", row) && <span className="pill ok">лучшая по выручке</span>}</td>
                <td className="mono">{row.p3_done} / {row.p3_due}</td>
                <td className="mono">{row.jobs_done} / {row.jobs_due}</td>
                <td className="mono">{usd(row.revenue_usd)}</td>
                <td className="mono">{row.below_reserve_steps}</td>
                <td className="mono">{row.mean_terminal_soc_pct.toFixed(1)}%</td>
                <td>{onFork && !row.current && <button className="btn btn-sm" onClick={() => onFork(row.goal, row.algorithm)}>Ветвь</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted tiny">{clock(r.from_step)}–{clock(r.until_step)} · {r.note} CP-SAT здесь не участвует: его ветвь — «Ветвь с другим алгоритмом».</p>
    </>
  );
}

function WhatIfView({ r }: { r: WhatIf }) {
  const best = r.variants[0];
  const gain = best.delta.p3_done !== 0 || best.delta.revenue_usd !== 0;
  return (
    <>
      <p className="finding">{gain
        ? <>Больше всего даёт «{best.label}»: {sign(best.delta.p3_done)} P3, {sign(best.delta.revenue_usd, usd)}.</>
        : <>Ни один ресурс не меняет результат — узкое место не в энергии и каналах, а в окнах связи заданий.</>}</p>
      <table className="table compact">
        <thead><tr><th>Вариант</th><th>P3 в срок</th><th>Выполнено</th><th>Выручка</th><th>Δ выручки</th></tr></thead>
        <tbody>
          <tr><td>{r.base.label}</td><td className="mono">{r.base.p3_done}/{r.base.p3_due}</td><td className="mono">{r.base.jobs_done}</td><td className="mono">{usd(r.base.revenue_usd)}</td><td className="mono muted">—</td></tr>
          {r.variants.map((v) => (
            <tr key={v.label}>
              <td>{v.label} {v.kind === "experiment" && <span className="pill">эксперимент</span>}</td>
              <td className="mono">{v.p3_done}/{v.p3_due} <span className={v.delta.p3_done > 0 ? "ok-text" : "muted"}>{sign(v.delta.p3_done)}</span></td>
              <td className="mono">{v.jobs_done}</td><td className="mono">{usd(v.revenue_usd)}</td>
              <td className={"mono " + (v.delta.revenue_usd > 0 ? "ok-text" : "muted")}>{sign(v.delta.revenue_usd, usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted tiny">{r.note} Расчёт — эвристикой по цели, полная смена с теми же сообщениями.</p>
    </>
  );
}

function FrontierView({ r }: { r: Frontier }) {
  const W = 560, H = 220, P = 44;
  const xs = r.points.map((p) => p.p3_done), ys = r.points.map((p) => p.revenue_usd);
  const [x0, x1, y0, y1] = [Math.min(...xs) - 1, Math.max(...xs) + 1, Math.min(...ys) - 20, Math.max(...ys) + 20];
  const x = (v: number) => P + ((v - x0) / (x1 - x0)) * (W - P - 16);
  const y = (v: number) => 12 + (1 - (v - y0) / (y1 - y0)) * (H - P);
  const front = r.points.filter((p) => !p.dominated).sort((a, b) => a.p3_done - b.p3_done || a.p3_bonus_usd - b.p3_bonus_usd);
  const lo = r.points[0];
  const hi = front.find((p) => p.p3_done === front[front.length - 1].p3_done && p.revenue_usd === front[front.length - 1].revenue_usd)!;
  // Одинаковые результаты при разных надбавках — одна точка с диапазоном в подписи.
  const groups = new Map<string, typeof r.points>();
  for (const p of r.points) groups.set(`${p.p3_done}|${p.revenue_usd}`, [...(groups.get(`${p.p3_done}|${p.revenue_usd}`) ?? []), p]);
  const perJob = hi.p3_done !== lo.p3_done ? (hi.revenue_usd - lo.revenue_usd) / (hi.p3_done - lo.p3_done) : 0;
  return (
    <>
      <p className="finding">
        От чистой выручки к надбавке ${hi.p3_bonus_usd} за P3: {sign(hi.p3_done - lo.p3_done)} срочных заданий,
        выручка {sign(hi.revenue_usd - lo.revenue_usd, usd)}{perJob > 0 ? " — компромисса нет, выигрывают оба показателя" : ""}.
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Компромисс между заданиями P3 и выручкой">
        {front.length > 1 && <polyline points={front.map((p) => `${x(p.p3_done)},${y(p.revenue_usd)}`).join(" ")} fill="none" stroke="#37c4b3" strokeWidth="1.5" />}
        {[...groups.values()].map((ps) => {
          const p = ps[0], b = ps.map((q) => q.p3_bonus_usd);
          return (
            <g key={p.p3_bonus_usd}>
              <circle cx={x(p.p3_done)} cy={y(p.revenue_usd)} r={p.dominated ? 4 : 6} fill={p.dominated ? "#3a3f44" : "#fff"} />
              <text x={x(p.p3_done) - 10} y={y(p.revenue_usd) - 10} textAnchor="end" fill="#9a9ea3" fontSize="11" fontFamily="JetBrains Mono">
                ${b.length > 1 ? `${Math.min(...b)}–${Math.max(...b)}` : b[0]} · {p.p3_done} · {usd(p.revenue_usd)}</text>
            </g>
          );
        })}
        <text x={P} y={H - 6} fill="#5e6268" fontSize="11">P3 в срок →</text>
        <text x={4} y={16} fill="#5e6268" fontSize="11">выручка ↑</text>
      </svg>
      <p className="muted tiny">Белые точки — недоминируемые настройки, серые — хуже по обоим показателям. {r.note}</p>
    </>
  );
}

function StressView({ r }: { r: Stress }) {
  return (
    <>
      <p className="finding">Наш планировщик лучше простого правила в {r.wins} из {r.runs} наборов отказов;
        в худшем наборе — {r.ours.p3_done.min} срочных против {r.baseline.p3_done.min}.</p>
      <div className="stress">
        {r.rows.map((row) => {
          // Шкала от общего минимума: разница в несколько заданий должна быть видна.
          const floor = Math.max(0, Math.min(...r.rows.map((q) => q.baseline.p3_done)) - 10);
          const top = Math.max(...r.rows.map((q) => q.ours.p3_due));
          const w = (v: number) => `${((v - floor) / Math.max(top - floor, 1)) * 100}%`;
          return (
            <div key={row.run} className="stress-row">
              <span className="mono tiny muted">#{row.run + 1}</span>
              <div className="bar2"><i className="ours" style={{ width: w(row.ours.p3_done) }} /><i className="base" style={{ width: w(row.baseline.p3_done) }} /></div>
              <span className="mono tiny">{row.ours.p3_done} / {row.baseline.p3_done}</span>
            </div>
          );
        })}
      </div>
      <p className="muted tiny"><i className="lg ours" /> наш <i className="lg base" /> простое правило · P3 в срок из {r.rows[0]?.ours.p3_due}; шкала от {Math.max(0, Math.min(...r.rows.map((q) => q.baseline.p3_done)) - 10)} · seed {r.seed}. {r.note}</p>
    </>
  );
}

function LinkView({ r }: { r: Link }) {
  const future = r.dark_windows.filter((w) => w.future);
  return (
    <>
      <p className="finding">{r.dark_windows.length === 0
        ? "Связь с Землёй возможна на каждом шаге смены."
        : `Окон без связи: ${r.dark_windows.length}, самое длинное — ${r.longest_dark_steps * 5} мин${future.length ? `; впереди ${future.length}` : ""}.`}</p>
      <div className="linkbar" title="Доступность канала на Землю по шагам">
        {r.dark_windows.map((w) => <i key={w.start} style={{ left: `${(w.start / r.steps) * 100}%`, width: `${Math.max((w.steps / r.steps) * 100, 0.4)}%` }} />)}
        <b style={{ left: `${(r.executed / r.steps) * 100}%` }} />
      </div>
      <p className="small">Хотя бы один аппарат может передавать: <b className="mono">{(r.contact_share * 100).toFixed(1)}%</b> времени.
        {r.used_share_executed != null && <> Передача реально шла: <b className="mono">{(r.used_share_executed * 100).toFixed(1)}%</b> прошедших шагов.</>}</p>
      {r.dark_windows.length > 0 && <p className="muted tiny mono">{r.dark_windows.slice(0, 8).map((w) => `${clock(w.start)}–${clock(w.end)}`).join(" · ")}</p>}
      <p className="muted tiny">{r.note}</p>
    </>
  );
}
