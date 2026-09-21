import { useState } from "react";
import { clock } from "../format";

// Ввод сообщения на текущей границе шага: форма для недоступности и отмены сеансов,
// JSON (вставка или файл) — для любого типа, включая пакет новых заданий.
// Проверку делает модель организаторов; отказ показывается как есть, состояние не меняется.
type Kind = "satellite_outage" | "close_downlink" | "json";

export default function EventComposer({ step, steps, satellites, usedIds, onSend, busy }: {
  step: number; steps: number; satellites: string[]; usedIds: string[];
  onSend: (event: unknown) => Promise<string | null>; busy: boolean;
}) {
  const nextId = () => { let n = usedIds.length + 1; while (usedIds.includes(`E-${n}`)) n++; return `E-${n}`; };
  const [kind, setKind] = useState<Kind>("satellite_outage");
  const [id, setId] = useState(nextId);
  const [sats, setSats] = useState<string[]>([]);
  const [end, setEnd] = useState(Math.min(step + 12, steps));
  const [json, setJson] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const build = (): unknown => {
    if (kind === "json") return JSON.parse(json);
    return { id, at_step: step, type: kind, satellite_ids: sats, end_step: end };
  };

  const send = async () => {
    let event: unknown;
    try { event = build(); } catch (e) { setResult({ ok: false, text: `Некорректный JSON: ${(e as Error).message}` }); return; }
    const error = await onSend(event);
    setResult(error ? { ok: false, text: error } : { ok: true, text: "Сообщение принято, план перестроится с этого шага." });
    if (!error) { setId(nextId()); setSats([]); setJson(""); }
  };

  const toggle = (sid: string) => setSats((x) => (x.includes(sid) ? x.filter((s) => s !== sid) : [...x, sid]));

  return (
    <div className="composer">
      <p className="muted small">Сообщение поступит на границе шага <b className="mono">{step}</b> ({clock(step)}), до выбора действий.</p>
      <div className="filters">
        <button className={"chip" + (kind === "satellite_outage" ? " on" : "")} onClick={() => setKind("satellite_outage")}>Недоступность аппаратов</button>
        <button className={"chip" + (kind === "close_downlink" ? " on" : "")} onClick={() => setKind("close_downlink")}>Отмена сеансов связи</button>
        <button className={"chip" + (kind === "json" ? " on" : "")} onClick={() => setKind("json")}>JSON / новые задания</button>
      </div>

      {kind === "json" ? (
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
      <button className="btn btn-primary" disabled={busy} onClick={send}>{busy ? "Отправка…" : "Отправить сообщение"}</button>
      {result && <p className={result.ok ? "ok-text" : "error"}>{result.text}</p>}
    </div>
  );
}
