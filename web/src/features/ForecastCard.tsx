import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Forecast, RunRecord } from "../api/types";
import { clock } from "../format";

// F4: прогноз на 2 часа — прогон текущего планировщика вперёд, не факт.
const ICON = { energy: "⚡", p3: "◆", calibration: "◎" } as const;

export default function ForecastCard({ run }: { run: RunRecord }) {
  const [f, setF] = useState<Forecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const done = run.steps_executed >= 288;

  useEffect(() => {
    if (done) return;
    let live = true;
    setF(null); setError(null);
    const t = setTimeout(() => api.f.forecast(run).then((x) => live && setF(x)).catch((e) => live && setError(e.message)), 250);
    return () => { live = false; clearTimeout(t); };
  }, [run, done]);

  if (done) return null;
  const shown = f ? (all ? f.alerts : f.alerts.filter((a) => a.severity !== "low").slice(0, 6)) : [];
  const low = f ? f.alerts.filter((a) => a.severity === "low").length : 0;
  return (
    <section className="card">
      <div className="card-head"><h2>Прогноз на 2 часа</h2>{f && <span className="muted tiny mono">до {clock(f.until_step)}</span>}</div>
      {error && <p className="error">{error}</p>}
      {!f && !error && <div className="skeleton" />}
      {f && shown.length === 0 && <p className="ok-text">Дефицита заряда и срывов P3 не ожидается.</p>}
      <ul className="alerts">
        {shown.map((a, i) => (
          <li key={i} className={a.severity}><span className="mono tiny muted">{clock(a.step)}</span> {ICON[a.kind]} {a.text}</li>
        ))}
      </ul>
      {f && low > 0 && <button className="chip" onClick={() => setAll(!all)}>{all ? "скрыть калибровки" : `+ ${low} калибровок по сроку`}</button>}
      {f && <p className="muted tiny">{f.note}</p>}
    </section>
  );
}
