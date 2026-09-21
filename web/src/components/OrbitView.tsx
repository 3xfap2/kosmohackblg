import { useEffect, useMemo, useRef, useState } from "react";
import type { EventRecord } from "../api/types";
import type { Board, Cell } from "../lib/cells";
import { REASON, clock } from "../format";

// «Живая орбита»: схема группировки на выбранном шаге.
// Координат спутников в данных нет, поэтому положение — схематичное: фаза на орбите
// восстанавливается из ряда solar_w (где у аппарата тень), а тень Земли рисуется справа от
// планеты. Цвет точки — фактически выполненное действие из журнала модели.
// Колесо — приближение к курсору, перетаскивание — сдвиг, клик — карточка спутника.
interface Props {
  board: Board;
  events: EventRecord[];
  step: number;
  onStep: (k: number) => void;
  selected?: string;
  onSelect?: (sid: string) => void;
}

type State = "relay" | "downlink" | "calibrate" | "idle" | "down" | "rejected";
const COLOR: Record<State, string> = {
  relay: "#b4a4ff", downlink: "#6cb6ff", calibrate: "#f5c451", idle: "#8b9097", down: "#ff8a85", rejected: "#ff8a85",
};
const LABEL: Record<State, string> = {
  relay: "ретранслирует трафик", downlink: "передаёт данные на Землю", calibrate: "калибруется",
  idle: "ждёт", down: "недоступен", rejected: "команда отклонена",
};
const RINGS = [
  { r: 1.45, tilt: -0.22, squash: 0.34 },
  { r: 1.62, tilt: 0.16, squash: 0.3 },
  { r: 1.79, tilt: -0.08, squash: 0.4 },
  { r: 1.96, tilt: 0.26, squash: 0.28 },
  { r: 2.13, tilt: -0.3, squash: 0.36 },
  { r: 2.3, tilt: 0.05, squash: 0.42 },
  { r: 2.47, tilt: -0.15, squash: 0.3 },
  { r: 2.64, tilt: 0.2, squash: 0.38 },
];
const ZOOM_MIN = 1, ZOOM_MAX = 6, LABELS_FROM = 2.2;

interface SatOrbit { ring: number; period: number; starts: number[]; shadowLen: number }

function orbitOf(dark: string, ring: number): SatOrbit {
  const starts: number[] = [];
  let len = 0, run = 0, runs = 0;
  [...dark].forEach((d, k) => {
    const isDark = d === "1";
    if (isDark && (k === 0 || dark[k - 1] !== "1")) starts.push(k);
    if (isDark) run++; else if (run) { len += run; runs++; run = 0; }
  });
  const gaps = starts.slice(1).map((s, i) => s - starts[i]).sort((a, b) => a - b);
  const period = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 19;
  return { ring, period, starts, shadowLen: runs ? len / runs : period * 0.37 };
}

// Угол на орбите: тень (solar_w = 0) — дуга вокруг θ = 0 (справа от планеты).
function angle(o: SatOrbit, k: number) {
  const arc = (2 * Math.PI * o.shadowLen) / o.period;
  let s = o.starts.filter((x) => x <= k).pop();
  if (s === undefined) s = (o.starts[0] ?? 0) - o.period;
  return -arc / 2 + (2 * Math.PI * (k - s)) / o.period;
}

function stars(n: number, w: number, h: number) {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => ({ x: rnd() * w, y: rnd() * h, r: rnd() * 1.1 + 0.2, a: rnd() * 0.5 + 0.15, tw: rnd() * 6 }));
}

export default function OrbitView({ board, events, step, onStep, selected, onSelect }: Props) {
  const steps = board.steps;
  const last = Math.max(board.executed - 1, 0);
  const ref = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [hover, setHover] = useState<{ sid: string; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [cardOpen, setCardOpen] = useState(false);   // карточка — только по явному клику
  const view = useRef({ zoom: 1, px: 0, py: 0 });          // для цикла отрисовки без перезапуска
  const drag = useRef<{ x: number; y: number; px: number; py: number; moved: boolean } | null>(null);
  const pos = useRef<Record<string, { x: number; y: number }>>({});
  const frac = useRef(step);

  const { sats, byStep, bySat, orbits } = useMemo(() => {
    const byStep: Record<number, Record<string, Cell>> = {};
    const bySat: Record<string, Cell[]> = {};
    for (const c of board.cells) {
      (byStep[c.step] ??= {})[c.satellite_id] = c;
      (bySat[c.satellite_id] ??= []).push(c);
    }
    const sats = board.satellites;
    const orbits: Record<string, SatOrbit> = {};
    sats.forEach((sid, i) => { orbits[sid] = orbitOf(board.dark[sid] ?? "", i % RINGS.length); });
    return { sats, byStep, bySat, orbits };
  }, [board]);
  const isDark = (sid: string, k: number) => (board.dark[sid] ?? "")[k] === "1";

  const outages = useMemo(() => events.filter((e) => e.type === "satellite_outage"), [events]);
  const stateOf = (sid: string, k: number): State => {
    const r = byStep[k]?.[sid];
    if (outages.some((e) => e.type === "satellite_outage" && e.satellite_ids.includes(sid) && e.at_step <= k && k < e.end_step)) return "down";
    if (!r) return "idle";
    if (r.executed === "calibrate") return "calibrate";
    if (r.executed === "job") return r.kind ?? "relay";
    if (r.rejected) return "rejected";
    return "idle";
  };

  const k = Math.min(step, last);
  const counts = useMemo(() => {
    const c: Record<string, number> = { relay: 0, downlink: 0, calibrate: 0, idle: 0, down: 0, rejected: 0, dark: 0 };
    for (const sid of sats) {
      c[stateOf(sid, k)]++;
      if (isDark(sid, k)) c.dark++;
    }
    return c;
  }, [sats, k, byStep]); // eslint-disable-line react-hooks/exhaustive-deps

  // Проигрывание смены.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const next = step + 1;
      if (next > last) { setPlaying(false); return; }
      onStep(next);
    }, 220 / speed);
    return () => clearInterval(id);
  }, [playing, speed, step, last, onStep]);

  // Масштаб относительно точки (sx, sy) на экране: точка под курсором остаётся на месте.
  const zoomAt = (factor: number, sx?: number, sy?: number) => {
    const c = ref.current!;
    const w = c.clientWidth, h = c.clientHeight;
    const v = view.current;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.zoom * factor));
    const ax = (sx ?? w / 2) - w / 2, ay = (sy ?? h / 2) - h / 2;
    v.px = ax - ((ax - v.px) * next) / v.zoom;
    v.py = ay - ((ay - v.py) * next) / v.zoom;
    v.zoom = next;
    if (next === ZOOM_MIN) { v.px = 0; v.py = 0; }
    setZoom(next);
  };
  const resetView = () => { view.current = { zoom: 1, px: 0, py: 0 }; setZoom(1); };

  useEffect(() => {
    const c = ref.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX - rect.left, e.clientY - rect.top);
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    return () => c.removeEventListener("wheel", onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Отрисовка: плавное движение к текущему шагу.
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let sky: ReturnType<typeof stars> | null = null;
    const draw = (now: number) => {
      const w = c.parentElement!.clientWidth, h = Math.max(440, Math.min(600, w * 0.55));
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c.style.width = w + "px"; c.style.height = h + "px"; sky = null;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      frac.current = reduce ? step : frac.current + (step - frac.current) * 0.16;
      if (Math.abs(step - frac.current) > 6) frac.current = step;
      const t = frac.current;
      const { zoom: z, px, py } = view.current;
      const cx = w / 2 + px, cy = h / 2 + py, R = Math.min(h * 0.19, w * 0.115) * z;

      g.fillStyle = "#030406"; g.fillRect(0, 0, w, h);
      // Звёзды с лёгким параллаксом и мерцанием.
      sky ??= stars(260, w, h);
      for (const s of sky) {
        const tw = reduce ? 1 : 0.75 + 0.25 * Math.sin(now / 900 + s.tw);
        g.globalAlpha = s.a * tw; g.fillStyle = "#dfe6ff";
        g.beginPath(); g.arc((s.x + px * 0.08 + w) % w, (s.y + py * 0.08 + h) % h, s.r, 0, 7); g.fill();
      }
      g.globalAlpha = 1;

      // Тень Земли — вправо (Солнце слева).
      const shade = g.createLinearGradient(cx, 0, cx + R * 3.4, 0);
      shade.addColorStop(0, "rgba(6,8,14,0.92)"); shade.addColorStop(1, "rgba(6,8,14,0)");
      g.fillStyle = shade; g.fillRect(cx, cy - R, R * 3.4, 2 * R);

      const place = (sid: string) => {
        const o = orbits[sid], ring = RINGS[o.ring];
        const th = angle(o, t);
        const x0 = Math.cos(th) * R * ring.r, y0 = Math.sin(th) * R * ring.r * ring.squash;
        return {
          x: cx + x0 * Math.cos(ring.tilt) - y0 * Math.sin(ring.tilt),
          y: cy + x0 * Math.sin(ring.tilt) + y0 * Math.cos(ring.tilt),
          front: Math.sin(th) > 0,
        };
      };

      // Орбиты; орбита выбранного спутника подсвечена.
      const selRing = selected ? orbits[selected]?.ring : undefined;
      RINGS.forEach((ring, i) => {
        g.save(); g.translate(cx, cy); g.rotate(ring.tilt);
        g.strokeStyle = i === selRing ? "rgba(180,164,255,0.45)" : "rgba(255,255,255,0.06)";
        g.lineWidth = i === selRing ? 1.2 : 1;
        g.beginPath(); g.ellipse(0, 0, R * ring.r, R * ring.r * ring.squash, 0, 0, Math.PI * 2); g.stroke();
        g.restore();
      });

      const kk = Math.min(Math.round(t), last);
      const pulse = reduce ? 0 : (Math.sin(now / 420) + 1) / 2;
      const drawSat = (sid: string, p: { x: number; y: number }) => {
        const st = stateOf(sid, kk);
        const dark = isDark(sid, kk);
        const col = COLOR[st];
        const size = Math.min(1 + (z - 1) * 0.25, 1.9);
        if (st === "downlink") {
          const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
          const beam = g.createLinearGradient(p.x, p.y, cx + (dx / d) * R, cy + (dy / d) * R);
          beam.addColorStop(0, "rgba(108,182,255,0.85)"); beam.addColorStop(1, "rgba(108,182,255,0.05)");
          g.strokeStyle = beam; g.lineWidth = 1.4;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(cx + (dx / d) * R, cy + (dy / d) * R); g.stroke();
        }
        if (st === "relay" || st === "downlink" || st === "calibrate") {
          const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, (9 + pulse * 3) * size);
          halo.addColorStop(0, col + "55"); halo.addColorStop(1, col + "00");
          g.fillStyle = halo; g.beginPath(); g.arc(p.x, p.y, (9 + pulse * 3) * size, 0, 7); g.fill();
        }
        g.globalAlpha = dark && st === "idle" ? 0.4 : 1;
        g.fillStyle = col; g.beginPath(); g.arc(p.x, p.y, (st === "idle" ? 2.4 : 3.4) * size, 0, 7); g.fill();
        if (st === "down") { g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.arc(p.x, p.y, 6.5 * size, 0, 7); g.stroke(); }
        g.globalAlpha = 1;
        const isSel = sid === selected;
        if (isSel) {
          g.strokeStyle = "#ffffff"; g.lineWidth = 1.2;
          g.beginPath(); g.arc(p.x, p.y, (10 + pulse * 2) * size, 0, 7); g.stroke();
        }
        if (isSel || z >= LABELS_FROM) {
          g.fillStyle = isSel ? "#ffffff" : "rgba(223,230,255,0.55)";
          g.font = `${isSel ? 12 : 10}px JetBrains Mono, monospace`;
          g.fillText(sid, p.x + 8 * size, p.y - 6 * size);
        }
      };

      const placed = sats.map((sid) => ({ sid, ...place(sid) }));
      pos.current = Object.fromEntries(placed.map((p) => [p.sid, { x: p.x, y: p.y }]));
      for (const p of placed) if (!p.front) drawSat(p.sid, p);

      // Земля: освещена слева, атмосфера — тонкое свечение по краю.
      const glow = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.25);
      glow.addColorStop(0, "rgba(108,182,255,0.18)"); glow.addColorStop(1, "rgba(108,182,255,0)");
      g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, R * 1.25, 0, 7); g.fill();
      const earth = g.createRadialGradient(cx - R * 0.45, cy - R * 0.35, R * 0.08, cx, cy, R);
      earth.addColorStop(0, "#3b6aa8"); earth.addColorStop(0.45, "#173356"); earth.addColorStop(0.8, "#0a1526"); earth.addColorStop(1, "#04070c");
      g.fillStyle = earth; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.strokeStyle = "rgba(140,200,255,0.35)"; g.lineWidth = 1.2;
      g.beginPath(); g.arc(cx, cy, R + 1, Math.PI * 0.55, Math.PI * 1.45); g.stroke();

      for (const p of placed) if (p.front) drawSat(p.sid, p);

      g.fillStyle = "rgba(223,230,255,0.4)"; g.font = "11px JetBrains Mono, monospace";
      g.fillText("☀ Солнце", 14, h / 2 + 4);
      if (!reduce || playing) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sats, orbits, byStep, step, last, selected, zoom, playing]); // eslint-disable-line react-hooks/exhaustive-deps

  const nearest = (x: number, y: number) => {
    let best: string | null = null, bd = 16;
    for (const [sid, p] of Object.entries(pos.current)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = sid; }
    }
    return best;
  };
  const local = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hovered = hover ? byStep[k]?.[hover.sid] : undefined;
  const eventsNow = events.filter((e) => e.at_step <= k && k < e.at_step + 12);
  const sel = selected ? byStep[k]?.[selected] : undefined;
  const selHistory = selected ? (bySat[selected] ?? []).filter((c) => c.step <= k && c.step > k - 36) : [];
  const nextBusy = selected ? (bySat[selected] ?? []).find((c) => c.step > k && c.executed !== "idle") : undefined;

  return (
    <div className="orbit">
      <p className="orbit-lead">
        Каждая точка — спутник, цвет — чем он занят в эту минуту. Справа от Земли тень: там панели не дают
        энергии и спутник живёт на батарее. Колесо мыши приближает, перетаскивание сдвигает, клик по спутнику
        открывает его карточку.
      </p>
      <div className={"orbit-stage" + (zoom > 1 ? " zoomed" : "")}>
        <canvas
          ref={ref}
          style={{ display: "block", touchAction: "none" }}
          onPointerDown={(e) => {
            const p = local(e);
            drag.current = { x: p.x, y: p.y, px: view.current.px, py: view.current.py, moved: false };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const p = local(e);
            const d = drag.current;
            if (d) {
              if (Math.hypot(p.x - d.x, p.y - d.y) > 4) d.moved = true;
              if (d.moved && view.current.zoom > 1) { view.current.px = d.px + p.x - d.x; view.current.py = d.py + p.y - d.y; }
            }
            const sid = nearest(p.x, p.y);
            setHover(sid && !d?.moved ? { sid, x: p.x, y: p.y } : null);
          }}
          onPointerUp={(e) => {
            const p = local(e);
            const d = drag.current; drag.current = null;
            if (d && !d.moved) { const sid = nearest(p.x, p.y); if (sid) { onSelect?.(sid); setCardOpen(true); } }
          }}
          onPointerLeave={() => setHover(null)}
          onDoubleClick={(e) => { const rect = ref.current!.getBoundingClientRect(); zoomAt(1.6, e.clientX - rect.left, e.clientY - rect.top); }}
          aria-label="Схема группировки на выбранном шаге"
        />
        <div className="orbit-clock mono">
          <div className="orbit-time">{clock(k)}</div>
          <div className="muted">шаг {k} из {steps}{board.executed < steps ? ` · выполнено ${board.executed}` : ""}</div>
        </div>
        <ul className="orbit-counts">
          {(["downlink", "relay", "calibrate", "idle", "down"] as State[]).map((s) => (
            <li key={s}><i style={{ background: COLOR[s], boxShadow: `0 0 8px ${COLOR[s]}66` }} />{LABEL[s]}<b className="mono">{counts[s]}</b></li>
          ))}
          <li><i style={{ background: "#0b0e14", border: "1px solid #3a3f44" }} />в тени Земли<b className="mono">{counts.dark}</b></li>
        </ul>
        <div className="orbit-zoom">
          <button className="icon-btn" onClick={() => zoomAt(1.4)} aria-label="Приблизить">+</button>
          <span className="mono">{zoom.toFixed(1)}×</span>
          <button className="icon-btn" onClick={() => zoomAt(1 / 1.4)} aria-label="Отдалить">−</button>
          <button className="icon-btn" onClick={resetView} aria-label="Сбросить вид" disabled={zoom === 1}>⟲</button>
        </div>
        {eventsNow.length > 0 && (
          <div className="orbit-event mono">
            {eventsNow.map((e) => (
              <div key={e.id}>⚡ {clock(e.at_step)} {e.type === "add_jobs" ? "срочные задания"
                : e.type === "satellite_outage" ? `отказ ${e.satellite_ids.join(", ")}` : "отмена сеансов связи"}</div>
            ))}
          </div>
        )}
        {selected && cardOpen && (
          <div className="sat-card" key={selected}>
            <div className="sat-card-head">
              <span className="id big">{selected}</span>
              <span className="state-pill" style={{ color: COLOR[stateOf(selected, k)], borderColor: COLOR[stateOf(selected, k)] + "55" }}>
                <i style={{ background: COLOR[stateOf(selected, k)] }} />{LABEL[stateOf(selected, k)]}
              </span>
              <button className="icon-btn sm" onClick={() => setCardOpen(false)} aria-label="Закрыть карточку">×</button>
            </div>
            <dl>
              <dt>Задание</dt><dd className="mono">{sel?.executed === "job" ? <span className="id">{sel.job_id}</span> : "—"}</dd>
              <dt>Заряд</dt><dd className="mono">{sel ? `${sel.soc.toFixed(1)}%` : "—"}</dd>
              <dt>Температура</dt><dd className="mono">{sel ? `${sel.temp.toFixed(1)} °C` : "—"}</dd>
              <dt>Освещение</dt><dd>{isDark(selected, k) ? "в тени — работа на батарее" : "на солнце — заряжается"}</dd>
              {sel?.rejected && <><dt>Отказ</dt><dd className="error">{REASON[sel.reason ?? ""] ?? sel.reason}</dd></>}
              <dt>Дальше</dt><dd>{nextBusy ? <>{clock(nextBusy.step)} · {nextBusy.executed === "calibrate" ? "калибровка" : <span className="id">{nextBusy.job_id}</span>}</> : "до конца смены без работы"}</dd>
            </dl>
            <Spark cells={selHistory} />
            <p className="muted tiny">Заряд за последние 3 часа до {clock(k)}</p>
          </div>
        )}
        {hover && (
          <div className="tip" style={{ left: hover.x + 14, top: hover.y + 10 }}>
            <div><span className="id">{hover.sid}</span> · {LABEL[stateOf(hover.sid, k)]}</div>
            {hovered?.executed === "job" && <div className="id">{hovered.job_id}</div>}
            {hovered?.rejected && <div style={{ color: "var(--bad)" }}>{REASON[hovered.reason ?? ""] ?? hovered.reason}</div>}
            {hovered && <div className="muted">заряд {hovered.soc.toFixed(0)}% · {hovered.temp.toFixed(0)} °C</div>}
          </div>
        )}
      </div>

      <div className="orbit-controls">
        <button className="btn btn-play" disabled={last === 0} onClick={() => { if (step >= last) onStep(0); setPlaying(!playing); }}>
          {playing ? "❚❚  Пауза" : "▶  Проиграть смену"}
        </button>
        <div className="timeline">
          <input type="range" min={0} max={last} value={k} onChange={(e) => { setPlaying(false); onStep(+e.target.value); }}
            aria-label="Время смены" style={{ ["--p" as string]: `${(k / Math.max(last, 1)) * 100}%` }} />
          {events.map((e) => (
            <span key={e.id} className="tick" style={{ left: `${(e.at_step / Math.max(last, 1)) * 100}%` }} title={`${e.id} · ${clock(e.at_step)}`} />
          ))}
        </div>
        <div className="speed">
          {[1, 4, 12].map((s) => (
            <button key={s} className={"chip" + (speed === s ? " on" : "")} onClick={() => setSpeed(s)}>×{s}</button>
          ))}
        </div>
      </div>
      <p className="muted small">Схема: положение на орбите восстановлено по чередованию света и тени в данных, а не по реальной баллистике.</p>
    </div>
  );
}

function Spark({ cells }: { cells: Cell[] }) {
  if (cells.length < 2) return null;
  const W = 240, H = 44;
  const x = (i: number) => (i / (cells.length - 1)) * W;
  const y = (v: number) => 4 + (1 - v / 100) * (H - 8);
  const d = cells.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c.soc).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="spark" aria-hidden>
      <line x1={0} x2={W} y1={y(30)} y2={y(30)} stroke="#f5c451" strokeOpacity="0.5" strokeDasharray="3 3" />
      <path d={`${d}L${W},${H}L0,${H}Z`} fill="url(#sg)" />
      <path d={d} fill="none" stroke="#dfe6ff" strokeWidth="1.4" />
      <defs><linearGradient id="sg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#b4a4ff" stopOpacity="0.28" /><stop offset="1" stopColor="#b4a4ff" stopOpacity="0" /></linearGradient></defs>
    </svg>
  );
}
