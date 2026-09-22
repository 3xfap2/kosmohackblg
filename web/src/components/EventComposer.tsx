import { useState } from "react";
import { api } from "../api/client";
import type { EventRecord, Impact, RunRecord } from "../api/types";
import ImpactCard from "../features/ImpactCard";
import { clock } from "../format";

// Ввод сообщения на текущей границе шага: форма для недоступности и отмены сеансов,
// JSON (вставка или файл) — для любого типа, включая пакет новых заданий.
// Проверку делает модель организаторов; отказ показывается как есть, состояние не меняется.
type Kind = "satellite_outage" | "close_downlink" | "json" | "text";

export default function EventComposer({ run, step, steps, satellites, usedIds, onSend, busy, suggestions = [] }: {
  run: RunRecord; suggestions?: EventRecord[]; step: number; steps: number; satellites: string[]; usedIds: string[];
  onSend: (event: unknown) => Promise<string | null>; busy: boolean;
}) {
  // Свободный номер сообщения: список занятых приходит из журнала смены и меняется после отправки.
  const freeId = (taken: string[]) => { let n = taken.length + 1; while (taken.includes(`E-${n}`)) n++; return `E-${n}`; };
  const [kind, setKind] = useState<Kind>("satellite_outage");
  const [typedId, setId] = useState("");
  // Занятый номер заменяется свободным сразу, как только сообщение попало в журнал смены:
  // так второе сообщение на том же шаге не уходит с идентификатором первого.
  const id = typedId && !usedIds.includes(typedId) ? typedId : freeId(usedIds);
  const [sats, setSats] = useState<string[]>([]);
  const [end, setEnd] = useState(Math.min(step + 12, steps));
  const [json, setJson] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [text, setText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [assessing, setAssessing] = useState(false);

  // Цена события до отправки: три ветви из текущего состояния (F1 + F3).
  const assess = async (event?: unknown) => {
    let ev = event;
    if (ev === undefined) { try { ev = build(); } catch (e) { setResult({ ok: false, text: `Некорректный JSON: ${(e as Error).message}` }); return; } }
    setAssessing(true); setImpact(null); setResult(null);
    try { setImpact(await api.f.impact(run, ev)); } catch (e) { setResult({ ok: false, text: (e as Error).message }); } finally { setAssessing(false); }
  };

  // Текст → черновик JSON (ИИ). Черновик не отправляется сам: оператор проверяет и подтверждает.
  const draft = async () => {
    setDrafting(true); setResult(null);
    try {
      const r = await api.draftEvent(run, text);
      if (r.event) { setJson(JSON.stringify(r.event, null, 2)); setKind("json");
        setResult({ ok: true, text: "Черновик готов — проверьте JSON и нажмите «Отправить»." + (r.note ? ` ${r.note}` : "") }); }
      else setResult({ ok: false, text: r.error ?? "Не удалось разобрать сообщение." });
    } catch (e) { setResult({ ok: false, text: (e as Error).message }); } finally { setDrafting(false); }
  };

  const build = (): unknown => {
    if (kind === "json") return JSON.parse(json);
    return { id, at_step: step, type: kind, satellite_ids: sats, end_step: end };
  };

  const send = async () => {
    let event: unknown;
    try { event = build(); } catch (e) { setResult({ ok: false, text: `Некорректный JSON: ${(e as Error).message}` }); return; }
    const error = await onSend(event);
    setResult(error ? { ok: false, text: error } : { ok: true, text: "Сообщение принято, план перестроится с этого шага." });
    if (!error) { setId(""); setSats([]); setJson(""); }
  };

  const toggle = (sid: string) => setSats((x) => (x.includes(sid) ? x.filter((s) => s !== sid) : [...x, sid]));

  return (
    <div className="composer">
      {suggestions.filter((e) => !usedIds.includes(e.id)).map((e) => (
        <div key={e.id} className={"suggest" + (e.at_step === step ? " ready" : "")}>
          <div>
            <span className="mono tiny muted">пример организаторов · {clock(e.at_step)}</span>
            <p><span className="id">{e.id}</span> {describe(e)}</p>
          </div>
          {e.at_step === step
            ? <span className="row-inline"><button className="btn" disabled={assessing} onClick={() => assess(e)}>Оценить</button>
              <button className="btn btn-primary" disabled={busy} onClick={async () => {
                const error = await onSend(e);
                setResult(error ? { ok: false, text: error } : { ok: true, text: `${e.id} принято — план перестроится с этого шага.` });
              }}>Отправить</button></span>
            : <span className="muted tiny">{e.at_step > step ? `доступно на шаге ${e.at_step}` : "момент прошёл"}</span>}
        </div>
      ))}
      <p className="muted small">Сообщение поступит на границе шага <b className="mono">{step}</b> ({clock(step)}), до выбора действий.</p>
      <div className="filters">
        <button className={"chip" + (kind === "satellite_outage" ? " on" : "")} onClick={() => setKind("satellite_outage")}>Недоступность аппаратов</button>
        <button className={"chip" + (kind === "close_downlink" ? " on" : "")} onClick={() => setKind("close_downlink")}>Отмена сеансов связи</button>
        <button className={"chip" + (kind === "json" ? " on" : "")} onClick={() => setKind("json")}>JSON / новые задания</button>
        <button className={"chip" + (kind === "text" ? " on" : "")} onClick={() => setKind("text")}>Текстом (ИИ)</button>
      </div>

      {kind === "text" ? (
        <>
          <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Например: S08 и S10 недоступны до 07:30" />
          <button className="btn" disabled={drafting || !text.trim()} onClick={draft}>{drafting ? "Разбор…" : "Составить черновик"}</button>
        </>
      ) : kind === "json" ? (
        <>
          <textarea className="input mono" rows={8} value={json} onChange={(e) => setJson(e.target.value)}
            placeholder={`{"id": "E-NEW", "at_step": ${step}, "type": "add_jobs", "jobs": [ … ]}`} />
          <label className="btn file">Загрузить файл
            <input type="file" accept=".json,application/json" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; if (f) setJson(await f.text());
            }} />
          </label>
        </>
      ) : (
        <>
          <label className="field">Идентификатор <input className="input mono" value={id} onChange={(e) => setId(e.target.value)} /></label>
          <div className="field">Аппараты <span className="muted small">({sats.length} выбрано)</span></div>
          <div className="sat-grid">
            {satellites.map((sid) => (
              <button key={sid} className={"sat" + (sats.includes(sid) ? " on" : "")} onClick={() => toggle(sid)}>{sid}</button>
            ))}
          </div>
          <label className="field">До шага (не включая)
            <input className="input mono" type="number" min={step + 1} max={steps} value={end}
              onChange={(e) => setEnd(+e.target.value)} />
            <span className="muted small">{clock(end)}</span>
          </label>
        </>
      )}
      {kind !== "text" && (
        <div className="row-inline">
          <button className="btn" disabled={assessing} onClick={() => assess()}>{assessing ? "Считаю 3 ветви…" : "Оценить последствия"}</button>
          <button className="btn btn-primary" disabled={busy} onClick={send}>{busy ? "Отправка…" : "Отправить"}</button>
        </div>
      )}
      {assessing && <div className="skeleton" />}
      {impact && <ImpactCard r={impact} />}
      {result && <p className={result.ok ? "ok-text" : "error"}>{result.text}</p>}
    </div>
  );
}

function describe(e: EventRecord): string {
  if (e.type === "add_jobs") return `новые задания: ${e.jobs.map((j) => j.id).join(", ")}`;
  const who = e.satellite_ids.length > 4 ? `${e.satellite_ids.length} аппаратов` : e.satellite_ids.join(", ");
  return e.type === "satellite_outage" ? `недоступны ${who} до ${clock(e.end_step)}` : `отмена сеансов связи: ${who} до ${clock(e.end_step)}`;
}
