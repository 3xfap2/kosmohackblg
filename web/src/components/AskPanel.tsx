import { useState } from "react";
import { api } from "../api/client";
import type { RunRecord } from "../api/types";

// «Спросить смену»: ответ только по фактам журнала. Источник ответа виден всегда.
const SOURCE: Record<string, string> = {
  ai: "ИИ по фактам журнала · проверено: все числа и идентификаторы есть в данных",
  template: "шаблон по фактам журнала (ИИ не подключён)",
  template_after_check: "шаблон: ответ ИИ не прошёл проверку по фактам и скрыт",
};
const EXAMPLES = ["Почему просрочено JOB-0002?", "Что делал S08 в 06:30?", "Как прошла смена?"];

export default function AskPanel({ run }: { run: RunRecord }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; source: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (question: string) => {
    if (!question.trim()) return;
    setQ(question); setBusy(true); setError(null);
    try { const r = await api.ask(run, question); setAnswer({ text: r.answer, source: r.source }); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <section className="card">
      <h2>Спросить смену</h2>
      <div className="row ask-row">
        <input className="input" value={q} placeholder="Почему сорвано задание…" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(q)} />
        <button className="btn" disabled={busy} onClick={() => send(q)}>{busy ? "…" : "Спросить"}</button>
      </div>
      <div className="filters">{EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => send(x)}>{x}</button>)}</div>
      {error && <p className="error">{error}</p>}
      {answer && (
        <div className="answer">
          <p>{answer.text}</p>
          <p className="muted small mono">{SOURCE[answer.source] ?? answer.source}</p>
        </div>
      )}
    </section>
  );
}
