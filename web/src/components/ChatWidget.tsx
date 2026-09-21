import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { RunRecord } from "../api/types";

// Ассистент смены: вопросы обычным языком, ответы только по фактам журнала этой смены.
// Под каждым ответом — источник: ИИ (проверен по фактам) или шаблон.
interface Msg { role: "user" | "bot"; text: string; source?: string }

const SOURCE: Record<string, string> = {
  ai: "ИИ · проверено по журналу",
  template: "по журналу · без ИИ",
  template_after_check: "по журналу · ответ ИИ не прошёл проверку",
};
const EXAMPLES = ["Как прошла смена?", "Почему просрочено JOB-0002?", "Что делал S08 в 06:30?"];

export default function ChatWidget({ run }: { run: RunRecord }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([
    { role: "bot", text: "Я отвечаю по журналу этой смены: что делал аппарат, почему сорвано задание, чем закончилась смена. Назовите задание (JOB-…), аппарат (S…) или время." },
  ]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    setQ(""); setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: question }]);
    try {
      const r = await api.ask(run, question);
      setMsgs((m) => [...m, { role: "bot", text: r.answer, source: r.source }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "bot", text: `Не получилось ответить: ${(e as Error).message}` }]);
    } finally { setBusy(false); }
  };

  return (
    <>
      <button className={"chat-fab" + (open ? " open" : "")} onClick={() => setOpen(!open)} aria-label="Ассистент смены">
        <span className="chat-fab-icon" aria-hidden>{open ? "×" : "✦"}</span>
        {!open && <span className="chat-fab-label">Ассистент</span>}
      </button>
      <div className={"chat" + (open ? " open" : "")} role="dialog" aria-label="Ассистент смены" aria-hidden={!open}>
        <header className="chat-head">
          <div>
            <b>Ассистент смены</b>
            <span className="muted tiny">шаг {run.steps_executed} · ответы только по журналу</span>
          </div>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть">×</button>
        </header>
        <div className="chat-list" ref={list}>
          {msgs.map((m, i) => (
            <div key={i} className={"msg " + m.role}>
              <p>{m.text}</p>
              {m.source && <span className="msg-src">{SOURCE[m.source] ?? m.source}</span>}
            </div>
          ))}
          {busy && <div className="msg bot typing"><span /><span /><span /></div>}
        </div>
        {msgs.length < 3 && (
          <div className="chat-examples">{EXAMPLES.map((x) => <button key={x} className="chip" onClick={() => send(x)}>{x}</button>)}</div>
        )}
        <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(q); }}>
          <input ref={input} className="input" value={q} maxLength={500} placeholder="Спросите о смене…" onChange={(e) => setQ(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !q.trim()} aria-label="Отправить">↑</button>
        </form>
      </div>
    </>
  );
}
