import { useEffect, useMemo, useRef, useState } from "react";
import type { EventRecord } from "../api/types";
import type { Board, Cell } from "../lib/cells";
import { REASON, clock } from "../format";

// «Живая орбита»: схема группировки на выбранном шаге.
// Координат спутников в данных нет, поэтому положение — схематичное: фаза на орбите
// восстанавливается из ряда solar_w (где у аппарата тень), а тень Земли рисуется справа от
// планеты. Цвет точки — фактически выполненное действие из журнала модели.
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
  relay: "#baa7ff", downlink: "#70b8ff", calibrate: "#ffca16", idle: "#a1a4a5", down: "#ff9592", rejected: "#ff9592",
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
  return Array.from({ length: n }, () => ({ x: rnd() * w, y: rnd() * h, r: rnd() * 1.1 + 0.2, a: rnd() * 0.6 + 0.2 }));
}

export default function OrbitView({ board, events, step, onStep, selected, onSelect }: Props) {
  const steps = board.steps;
  const last = Math.max(board.executed - 1, 0);
  const ref = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [hover, setHover] = useState<{ sid: string; x: number; y: number } | null>(null);
  const pos = useRef<Record<string, { x: number; y: number }>>({});
  const frac = useRef(step);

  const { sats, byStep, orbits } = useMemo(() => {
    const byStep: Record<number, Record<string, Cell>> = {};
    for (const c of board.cells) (byStep[c.step] ??= {})[c.satellite_id] = c;
    const sats = board.satellites;
    const orbits: Record<string, SatOrbit> = {};
    sats.forEach((sid, i) => { orbits[sid] = orbitOf(board.dark[sid] ?? "", i % RINGS.length); });
    return { sats, byStep, orbits };
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

  // Отрисовка: плавное движение к текущему шагу.
  useEffect(() => {
    const c = ref.current!;
    const g = c.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let sky: ReturnType<typeof stars> | null = null;
    const draw = () => {
      const w = c.parentElement!.clientWidth, h = Math.max(420, Math.min(560, w * 0.52));
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
        c.style.width = w + "px"; c.style.height = h + "px"; sky = null;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      frac.current = reduce ? step : frac.current + (step - frac.current) * 0.18;
      if (Math.abs(step - frac.current) > 6) frac.current = step;
      const t = frac.current;
      const cx = w / 2, cy = h / 2, R = Math.min(h * 0.2, w * 0.12);

      g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
      sky ??= stars(220, w, h);
      for (const s of sky) { g.globalAlpha = s.a; g.fillStyle = "#fff"; g.beginPath(); g.arc(s.x, s.y, s.r, 0, 7); g.fill(); }
      g.globalAlpha = 1;

      // Тень Земли — вправо (Солнце слева).
      const shade = g.createLinearGradient(cx, 0, w, 0);
      shade.addColorStop(0, "rgba(11,14,20,0.95)"); shade.addColorStop(1, "rgba(11,14,20,0)");
      g.fillStyle = shade; g.fillRect(cx, cy - R, w - cx, 2 * R);

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

      // Орбиты.
      g.strokeStyle = "#16191c"; g.lineWidth = 1;
      for (const ring of RINGS) {
        g.save(); g.translate(cx, cy); g.rotate(ring.tilt);
        g.beginPath(); g.ellipse(0, 0, R * ring.r, R * ring.r * ring.squash, 0, 0, Math.PI * 2); g.stroke();
        g.restore();
      }

      const drawSat = (sid: string, p: { x: number; y: number }) => {
        const st = stateOf(sid, Math.min(Math.round(t), last));
        const dark = isDark(sid, Math.min(Math.round(t), last));
        const col = COLOR[st];
        if (st === "downlink") {
          const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy);
          g.strokeStyle = "rgba(112,184,255,0.55)"; g.lineWidth = 1.2;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(cx + (dx / d) * R, cy + (dy / d) * R); g.stroke();
        }
        if (st === "relay" || st === "downlink" || st === "calibrate") {
          g.fillStyle = col + "33"; g.beginPath(); g.arc(p.x, p.y, 8, 0, 7); g.fill();
        }
        g.globalAlpha = dark && st === "idle" ? 0.45 : 1;
        g.fillStyle = col; g.beginPath(); g.arc(p.x, p.y, st === "idle" ? 2.6 : 3.6, 0, 7); g.fill();
        if (st === "down") { g.strokeStyle = col; g.lineWidth = 1.2; g.beginPath(); g.arc(p.x, p.y, 6, 0, 7); g.stroke(); }
        g.globalAlpha = 1;
        if (sid === selected) {
          g.strokeStyle = "#fff"; g.lineWidth = 1; g.beginPath(); g.arc(p.x, p.y, 9, 0, 7); g.stroke();
          g.fillStyle = "#fff"; g.font = "11px JetBrains Mono, monospace"; g.fillText(sid, p.x + 12, p.y - 8);
        }
      };

      const placed = sats.map((sid) => ({ sid, ...place(sid) }));
      pos.current = Object.fromEntries(placed.map((p) => [p.sid, { x: p.x, y: p.y }]));
      for (const p of placed) if (!p.front) drawSat(p.sid, p);

      // Земля: освещена слева.
      const earth = g.createRadialGradient(cx - R * 0.45, cy - R * 0.3, R * 0.1, cx, cy, R);
      earth.addColorStop(0, "#2b4c7e"); earth.addColorStop(0.55, "#15253d"); earth.addColorStop(1, "#05080d");
      g.fillStyle = earth; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.strokeStyle = "rgba(112,184,255,0.35)"; g.lineWidth = 1.5;
      g.beginPath(); g.arc(cx, cy, R + 1.5, Math.PI * 0.55, Math.PI * 1.45); g.stroke();

      for (const p of placed) if (p.front) drawSat(p.sid, p);

      g.fillStyle = "#6e727a"; g.font = "11px JetBrains Mono, monospace";
      g.fillText("☀ Солнце", 12, cy + 4);
      g.fillText("тень Земли →", w - 118, cy + R + 16);
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sats, orbits, byStep, step, last, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const nearest = (e: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best: string | null = null, bd = 14;
    for (const [sid, p] of Object.entries(pos.current)) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = sid; }
    }
    return best ? { sid: best, x, y } : null;
  };

  const hovered = hover ? byStep[k]?.[hover.sid] : undefined;
  const eventsNow = events.filter((e) => e.at_step <= k && k < e.at_step + 12);

  return (
    <div className="orbit">
      <p className="orbit-lead">
        Каждая точка — спутник. Цвет — чем он занят в эту минуту. Справа от Земли — тень:
        там солнечные панели не дают энергии, и спутник живёт на батарее.
      </p>
      <div className="orbit-stage">
        <canvas
          ref={ref}
          style={{ display: "block", cursor: onSelect ? "pointer" : "default" }}
          onMouseMove={(e) => setHover(nearest(e))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => { const n = nearest(e); if (n && onSelect) onSelect(n.sid); }}
          aria-label="Схема группировки на выбранном шаге"
        />
        <div className="orbit-clock mono">
          <div className="orbit-time">{clock(k)}</div>
          <div className="muted">шаг {k} из {steps}{board.executed < steps ? ` · выполнено ${board.executed}` : ""}</div>
        </div>
        <ul className="orbit-counts">
          {(["downlink", "relay", "calibrate", "idle", "down"] as State[]).map((s) => (
            <li key={s}><i style={{ background: COLOR[s] }} />{LABEL[s]}<b className="mono">{counts[s]}</b></li>
          ))}
          <li><i style={{ background: "#0b0e14", border: "1px solid #292d30" }} />в тени Земли<b className="mono">{counts.dark}</b></li>
        </ul>
        {eventsNow.length > 0 && (
          <div className="orbit-event mono">
            {eventsNow.map((e) => (
              <div key={e.id}>⚡ {clock(e.at_step)} {e.type === "add_jobs" ? "срочные задания"
                : e.type === "satellite_outage" ? `отказ ${e.satellite_ids.join(", ")}` : "отмена сеансов связи"}</div>
            ))}
          </div>
        )}
        {hover && (
          <div className="tip" style={{ left: hover.x + 14, top: hover.y + 10 }}>
            <div><span className="id">{hover.sid}</span> · {LABEL[stateOf(hover.sid, k)]}</div>
            {hovered?.executed === "job" && <div className="id">{hovered.job_id}</div>}
            {hovered?.rejected && (
              <div style={{ color: "var(--bad)" }}>{REASON[hovered.reason ?? ""] ?? hovered.reason}</div>
            )}
            {hovered && <div className="muted">заряд {hovered.soc.toFixed(0)}% · {hovered.temp.toFixed(0)} °C</div>}
          </div>
        )}
      </div>

      <div className="orbit-controls">
        <button className="btn" disabled={last === 0} onClick={() => { if (step >= last) onStep(0); setPlaying(!playing); }}>
          {playing ? "❚❚ Пауза" : "▶ Проиграть смену"}
        </button>
        <div className="timeline">
          <input type="range" min={0} max={last} value={k} onChange={(e) => { setPlaying(false); onStep(+e.target.value); }}
            aria-label="Время смены" />
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
