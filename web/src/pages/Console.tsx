import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { ScenarioInfo } from "../api/types";

// Каркас консоли: пока только список сценариев. Экраны добавляются по CRITERIA.md.
export default function Console() {
  const [scenarios, setScenarios] = useState<ScenarioInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.scenarios().then(setScenarios).catch((e) => setError(e.message)); }, []);

  return (
    <div style={{ maxWidth: "var(--page)", margin: "0 auto", padding: 24 }}>
      <Link to="/" className="muted">← Созвездие</Link>
      <h1 style={{ font: "400 32px var(--font-display)", color: "var(--text-strong)" }}>Консоль оператора</h1>
      {error && <p className="error">API недоступен: {error}</p>}
      {!scenarios && !error && <p className="muted">Загрузка сценариев…</p>}
      {scenarios?.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: 12 }}>
          <span className="id">{s.id}</span> — {s.title}
          <span className="muted mono" style={{ marginLeft: 12 }}>{s.satellites} аппаратов · {s.steps} шагов · {s.jobs} заданий</span>
        </div>
      ))}
    </div>
  );
}
