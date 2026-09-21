import { useEffect, useMemo, useRef, useState } from "react";
import type { StepRow } from "../api/types";
import { REASON, clock } from "../format";

// Расписание «аппарат × шаг». Тень (solar_w = 0) — тёмная подложка, цвет ячейки — выполненное действие,
// красная засечка — отклонённая моделью команда.
interface Props {
  trace: StepRow[];
  kindOf: Record<string, "relay" | "downlink">;
  steps: number;
  currentStep: number;
  selected?: string;
  onSelect?: (satellite: string, step: number) => void;
}

const COLOR = { relay: "#baa7ff", downlink: "#70b8ff", calibrate: "#ffca16", reject: "#ff9592", shadow: "#0b0e14" };
const ROW = 12, LABEL = 44;

export default function Gantt({ trace, kindOf, steps, currentStep, selected, onSelect }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ row: StepRow; x: number; y: number } | null>(null);

  const { sats, grid } = useMemo(() => {
    const sats = [...new Set(trace.map((r) => r.satellite_id))].sort();
    const grid = new Map<string, StepRow>();
    for (const r of trace) grid.set(`${r.satellite_id}|${r.step}`, r);
    return { sats, grid };
  }, [trace]);

  useEffect(() => {
    const c = ref.current!;
    const w = c.parentElement!.clientWidth;
    const h = sats.length * ROW + 20;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr; c.style.width = w + "px"; c.style.height = h + "px";
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cw = (w - LABEL) / steps;
    g.font = "10px JetBrains Mono, monospace";
    sats.forEach((sid, i) => {
      const y = i * ROW;
      g.fillStyle = sid === selected ? "#ffffff" : "#6e727a";
      g.fillText(sid, 4, y + 9);
      for (let k = 0; k < steps; k++) {
        const r = grid.get(`${sid}|${k}`);
        if (!r) continue;
        const x = LABEL + k * cw;
        if (r.solar_w === 0) { g.fillStyle = COLOR.shadow; g.fillRect(x, y, cw + 0.5, ROW - 2); }
        let col: string | null = null;
        if (r.executed === "calibrate") col = COLOR.calibrate;
        else if (r.executed === "job") col = COLOR[kindOf[r.requested.job_id ?? ""] ?? "relay"];
        if (col) { g.fillStyle = col; g.fillRect(x, y + 1, Math.max(cw - 0.3, 1), ROW - 4); }
        if (r.requested.action !== "idle" && r.executed === "idle") {
          g.fillStyle = COLOR.reject; g.fillRect(x, y, Math.max(cw, 1.5), 2);
        }
      }
    });
    // Граница «сейчас» — всё правее ещё не выполнено.
    const xNow = LABEL + currentStep * cw;
    g.strokeStyle = "#ffffff"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xNow, 0); g.lineTo(xNow, sats.length * ROW); g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#6e727a";
    for (let k = 0; k <= steps; k += 36) g.fillText(clock(k), LABEL + k * cw, sats.length * ROW + 14);
  }, [sats, grid, kindOf, steps, currentStep, selected]);

  const locate = (e: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const cw = (rect.width - LABEL) / steps;
    const k = Math.floor((x - LABEL) / cw), i = Math.floor(y / ROW);
    const row = sats[i] && k >= 0 ? grid.get(`${sats[i]}|${k}`) : undefined;
    return { row, x, y };
  };

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={ref}
        style={{ cursor: onSelect ? "pointer" : "default" }}
        onMouseMove={(e) => { const { row, x, y } = locate(e); setHover(row ? { row, x, y } : null); }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => { const { row } = locate(e); if (row && onSelect) onSelect(row.satellite_id, row.step); }}
      />
      {hover && (
        <div className="tip" style={{ left: Math.min(hover.x + 12, 9999), top: hover.y + 12 }}>
          <div><span className="id">{hover.row.satellite_id}</span> · шаг {hover.row.step} · {clock(hover.row.step)}</div>
          <div>{hover.row.executed === "job" ? <span className="id">{hover.row.requested.job_id}</span> : hover.row.executed === "calibrate" ? "калибровка" : "ожидание"}</div>
          {hover.row.requested.action !== "idle" && hover.row.executed === "idle" && (
            <div style={{ color: "var(--bad)" }}>отклонено: {REASON[hover.row.reason] ?? hover.row.reason}</div>
          )}
          <div className="muted">заряд {hover.row.soc_after_pct.toFixed(1)}% · {hover.row.temp_after_c.toFixed(1)} °C</div>
        </div>
      )}
    </div>
  );
}
