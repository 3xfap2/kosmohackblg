import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { store } from "../api/store";
import type { Algorithm, EventRecord, Forecast, Goal, RunRecord, RunView } from "../api/types";
import { ALGO, GOAL, clock } from "../format";
import { GLOSSARY } from "../glossary";

// Шапка смены: всё, что нужно всегда, и всё кликабельно.
interface Props {
  run: RunRecord; view: RunView; busy: boolean; forecast: Forecast | null;
  onAdvance: (until: number) => void; onSeek: (step: number) => void;
  onGoal: (g: Goal) => void; onFork: (g?: Goal, a?: Algorithm) => void;
  onEvents: () => void; onForecast: () => void; suggestions: EventRecord[];
}

// Всплывающая панель: открывается по клику, закрывается кликом мимо или Esc.
function Pop({ label, children, className = "", title }: { label: ReactNode; children: (close: () => void) => ReactNode; className?: string; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", out); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("pointerdown", out); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className={"pop " + className} ref={ref}>
      <button className={"pop-btn" + (open ? " on" : "")} onClick={() => setOpen(!open)} aria-expanded={open} title={title}>{label}</button>
      {open && <div className="pop-panel">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export default function RunHeader({ run, view, busy, forecast, onAdvance, onSeek, onGoal, onFork, onEvents, onForecast, suggestions }: Props) {
  const nav = useNavigate();
  const total = view.steps_total, k = run.steps_executed, done = k >= total;
  const [family, setFamily] = useState<RunRecord[]>([]);
  const [hoverStep, setHoverStep] = useState<number | null>(null);
  const [ai, setAi] = useState<{ enabled: boolean } | null>(null);
  const [check, setCheck] = useState<{ state: "idle" | "busy" | "ok" | "fail"; text?: string }>({ state: "idle" });
  const [help, setHelp] = useState(false);

  useEffect(() => { api.aiStatus().then(setAi).catch(() => setAi(null)); }, []);
  // Семья веток: корень и все потомки из этого браузера.
  useEffect(() => {
    store.all().then((all) => {
      const byId = new Map(all.map((r) => [r.id, r]));
      let root = run;
      while (root.run_metadata.parent && byId.get(root.run_metadata.parent.run_id)) root = byId.get(root.run_metadata.parent.run_id)!;
      const inFamily = (r: RunRecord): boolean => r.id === root.id || (!!r.run_metadata.parent && !!byId.get(r.run_metadata.parent.run_id) && inFamily(byId.get(r.run_metadata.parent.run_id)!));
      setFamily(all.filter(inFamily));
    });
  }, [run]);
  let demoId: string | null = null;
  try { demoId = localStorage.getItem("sz_demo_run_v2"); } catch { /* нет хранилища */ }

  const alerts = forecast?.alerts ?? [];
  const serious = alerts.filter((a) => a.severity !== "low");
  const parent = view.parent ? family.find((r) => r.id === view.parent!.run_id) : undefined;
  const name = (r: RunRecord) => r.run_metadata.parent
    ? `ветвь «${GOAL[r.run_metadata.goal].split(" ")[0].toLowerCase()} · ${ALGO[r.run_metadata.algorithm].split(" ")[0].toLowerCase()}» от ${clock(r.run_metadata.parent.fork_step)}`
    : r.id === demoId ? "Демо-смена" : `Смена ${"ref" in r.scenario ? r.scenario.ref : "своя"}`;
  const depth = (r: RunRecord): number => r.run_metadata.parent ? 1 + depth(family.find((x) => x.id === r.run_metadata.parent!.run_id) ?? r) : 0;

  const pct = (s: number) => `${(s / total) * 100}%`;
  const stepAt = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(total, Math.round(((e.clientX - r.left) / r.width) * total)));
  };
  const pending = suggestions.filter((e) => e.at_step >= k && !view.events.some((x) => x.id === e.id));

  const verify = async () => {
    setCheck({ state: "busy" });
    try {
      const r = await api.verify(run);
      setCheck(r.match ? { state: "ok", text: `Повтор ${k} шагов официальной моделью совпал: команды, сообщения и сводка.` }
        : { state: "fail", text: "Повтор не совпал — сообщите разработчикам." });
    } catch (e) { setCheck({ state: "fail", text: (e as Error).message }); }
  };

  return (
    <div className="rh">
      <div className="rh-row">
        {/* 4 — ветви */}
        <Pop className="rh-crumb" label={<><span className="rh-crumb-main">{name(run)}</span><span className="chev">⌄</span></>} title="Ветви этой смены">
          {(close) => (
            <div className="menu">
              <p className="menu-title">Ветви этой смены</p>
              {[...family].sort((x, y) => depth(x) - depth(y) || (x.run_metadata.parent?.fork_step ?? 0) - (y.run_metadata.parent?.fork_step ?? 0)).map((r) => (
                <button key={r.id} className={"menu-item" + (r.id === run.id ? " on" : "")} style={{ paddingLeft: 12 + depth(r) * 16 }}
                  onClick={() => { close(); if (r.id !== run.id) nav(`/console/run/${r.id}`); }}>
                  {depth(r) > 0 && <span className="muted">└ </span>}{name(r)} <span className="muted mono tiny">· {clock(r.steps_executed)}</span>
                </button>
              ))}
              <div className="menu-sep" />
              {parent && <button className="menu-item" onClick={() => { close(); nav(`/console/compare?a=${parent.id}&b=${run.id}`); }}>⇄ Сравнить с родителем</button>}
              {!done && <button className="menu-item" onClick={() => { close(); onFork(view.goal === "priority" ? "revenue" : "priority"); }}>＋ Новая ветвь с другой целью</button>}
              <Link className="menu-item" to="/console/new" onClick={close}>＋ Новая смена</Link>
            </div>
          )}
        </Pop>

        {/* 3 — цель и алгоритм */}
        <Pop label={<><span className="muted tiny">цель</span> {GOAL[view.goal]} <span className="chev">⌄</span></>} title="Цель управления">
          {(close) => (
            <div className="menu">
              <p className="menu-title">Цель управления — влияет только на будущее</p>
              {(["priority", "revenue"] as Goal[]).map((g) => (
                <button key={g} className={"menu-item" + (view.goal === g ? " on" : "")} disabled={done || busy || view.goal === g}
                  onClick={() => { close(); onGoal(g); }}>{GOAL[g]}{view.goal === g && " ✓"}</button>
              ))}
              {view.goal_history.length > 1 && <p className="muted tiny menu-note">{view.goal_history.map((h) => `${clock(h.step)} → ${GOAL[h.goal]}`).join(" · ")}</p>}
            </div>
          )}
        </Pop>
        <Pop label={<><span className="muted tiny">алгоритм</span> {ALGO[view.algorithm.name].split(" (")[0]} <span className="chev">⌄</span></>} title="Алгоритм">
          {(close) => (
            <div className="menu">
              <p className="menu-title">Алгоритм фиксирован для смены — другой запускается ветвью из этого момента</p>
              {(["horizon-cpsat", "goal-greedy", "edf-baseline"] as Algorithm[]).map((a) => (
                <button key={a} className={"menu-item" + (view.algorithm.name === a ? " on" : "")} disabled={done || busy || view.algorithm.name === a}
                  onClick={() => { close(); onFork(undefined, a); }}>
                  {ALGO[a]}{view.algorithm.name === a ? " ✓" : <span className="muted tiny"> — ветвь от {clock(k)}</span>}
                </button>
              ))}
            </div>
          )}
        </Pop>

        <div className="rh-right">
          {/* 2 — риски */}
          <Pop className="rh-bell" title="Прогноз рисков на 2 часа" label={<>
            <span aria-hidden>🔔</span>{forecast == null && !done ? <span className="muted tiny">…</span> : <b className={serious.length ? "bad" : "okc"}>{serious.length}</b>}
          </>}>
            {(close) => (
              <div className="menu wide">
                <p className="menu-title">{done ? "Смена завершена — прогноза нет" : `Прогноз до ${forecast ? clock(forecast.until_step) : "…"}: ${serious.length ? `${serious.length} риска` : "рисков нет"}`}</p>
                {serious.slice(0, 8).map((a, i) => (
                  <button key={i} className={"menu-item alert " + a.severity} onClick={() => { close(); onForecast(); }}>
                    <span className="mono tiny muted">{clock(a.step)}</span> {a.text}
                  </button>
                ))}
                {!done && serious.length === 0 && forecast && <p className="menu-note ok-text">Дефицита заряда и срывов срочных заданий не ожидается.</p>}
                {!done && <button className="menu-item" onClick={() => { close(); onForecast(); }}>Весь прогноз ({alerts.length}) →</button>}
              </div>
            )}
          </Pop>

          {/* 5 — статус системы */}
          <Pop className="rh-status" title="Проверка расчёта" label={<><i className="dot-ok" />модель организаторов{ai && <span className="muted tiny"> · ИИ {ai.enabled ? "подключён" : "шаблоны"}</span>}</>}>
            {() => (
              <div className="menu wide">
                <p className="menu-title">Все числа считает официальная модель организаторов</p>
                <p className="menu-note small">Каждое действие проходит её проверку допуска; смена хранится как журнал команд и повторяется ею же. Отказов модели в этой смене: <b className="mono">{view.summary.blocked_command_count}</b>.</p>
                <button className="btn" disabled={check.state === "busy"} onClick={verify}>{check.state === "busy" ? "Повторяю журнал…" : "Проверить: повторить смену моделью"}</button>
                {check.text && <p className={check.state === "ok" ? "ok-text" : "error"}>{check.state === "ok" ? "✓ " : ""}{check.text}</p>}
                <p className="menu-note tiny muted">ИИ-ассистент: {ai?.enabled ? "подключён, ответы проверяются по фактам журнала" : "ключ не задан — ответы по шаблонам из журнала"}.</p>
              </div>
            )}
          </Pop>

          {/* 6 — помощь */}
          <button className="pop-btn rh-help" onClick={() => setHelp(true)} aria-label="Помощь и словарь">?</button>
        </div>
      </div>

      {/* 1 — прогресс смены */}
      <div className="rh-progress">
        <span className="mono rh-time">{clock(k)}</span>
        <div className="rh-bar" onMouseMove={(e) => setHoverStep(stepAt(e))} onMouseLeave={() => setHoverStep(null)}
          onClick={(e) => { const s = stepAt(e); if (s < k) onSeek(Math.max(s, 0)); else if (!done && !busy && s > k) onAdvance(s); }}
          role="slider" aria-label="Ход смены" aria-valuemin={0} aria-valuemax={total} aria-valuenow={k}>
          <i className="rh-done" style={{ width: pct(k) }} />
          {view.events.map((e) => <span key={e.id} className="rh-tick" style={{ left: pct(e.at_step) }} title={`${e.id} · ${clock(e.at_step)}`} />)}
          {pending.map((e) => <span key={e.id} className="rh-tick next" style={{ left: pct(e.at_step) }} title={`${e.id} · ${clock(e.at_step)} — ждёт отправки`} />)}
          {hoverStep != null && (
            <span className="rh-hover" style={{ left: pct(hoverStep) }}>
              {hoverStep < k ? `показать ${clock(hoverStep)}` : done ? "смена завершена" : hoverStep > k ? `досчитать до ${clock(hoverStep)}` : "сейчас"}
            </span>
          )}
        </div>
        <span className="mono muted rh-time">{clock(total)}</span>
        {!done && <button className="btn btn-primary rh-go" disabled={busy} onClick={() => onAdvance(Math.min(k + 12, total))}>+1 час</button>}
        {!done && pending.length > 0 && pending[0].at_step === k && <button className="btn rh-go" onClick={onEvents}>Сообщение {pending[0].id} ждёт</button>}
      </div>

      {help && <Help onClose={() => setHelp(false)} onEvents={() => { setHelp(false); onEvents(); }} />}
    </div>
  );
}

function Help({ onClose, onEvents }: { onClose: () => void; onEvents: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const go = (id: string) => { onClose(); document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  const TERMS: [string, string][] = [["p3", "Срочные задания (P3)"], ["step", "Шаг"], ["shadow", "Тень Земли"], ["reserve", "Резерв заряда"],
    ["downlink", "Передача на Землю"], ["relay", "Ретрансляция"], ["calibration", "Калибровка"], ["revenue", "Выручка"], ["blocked", "Отказы модели"], ["model", "Модель организаторов"]];
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Помощь" onClick={(e) => e.stopPropagation()}>
        <header><b>С чего начать</b><button className="icon-btn" onClick={onClose} aria-label="Закрыть">×</button></header>
        <div className="modal-body">
          <div className="help-steps">
            <button onClick={() => go("map")}><b>1 · Карта</b><span>Нажмите «✦ Рассказ» — смена проиграется с подписями ключевых моментов.</span></button>
            <button onClick={() => go("jobs")}><b>2 · Потери</b><span>Нажмите на сорванное задание — «Почему?» объяснит причину.</span></button>
            <button onClick={onEvents}><b>3 · Событие</b><span>Отправьте сообщение и нажмите «Оценить последствия» — увидите цену до решения.</span></button>
          </div>
          <h4>Словарь</h4>
          <dl className="glossary">
            {TERMS.map(([k, t]) => <div key={k}><dt>{t}</dt><dd>{GLOSSARY[k]}</dd></div>)}
          </dl>
        </div>
      </div>
    </div>
  );
}
