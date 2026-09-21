import { useEffect, useMemo, useRef, useState } from "react";
import type { Board, Cell } from "../lib/cells";
import { REASON, clock } from "../format";

// Расписание «аппарат × шаг». Тень — тёмная подложка на всю смену, цвет ячейки — выполненное
// действие, красная засечка — отклонённая моделью команда. Пунктир — выбранный момент.
interface Props {
  board: Board;
  cursor: number;
  selected?: string;
  onSelect?: (satellite: string, step: number) => void;
}

const COLOR = { relay: "#baa7ff", downlink: "#70b8ff", calibrate: "#ffca16", reject: "#ff9592", shadow: "#0b0e14" };
const ROW = 12, LABEL = 44;

export default function Gantt({ board, cursor, selected, onSelect }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number } | null>(null);
  const { satellites: sats, steps } = board;

  const grid = useMemo(() => {
    const g = new Map<string, Cell>();
    for (const c of board.cells) g.set(`${c.satellite_id}|${c.step}`, c);
    return g;
  }, [board]);

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
      const dark = board.dark[sid] ?? "";
      for (let k = 0; k < steps; k++) {
        const x = LABEL + k * cw;
        if (dark[k] === "1") { g.fillStyle = COLOR.shadow; g.fillRect(x, y, cw + 0.5, ROW - 2); }
        const cell = grid.get(`${sid}|${k}`);
        if (!cell) continue;
        const col = cell.executed === "calibrate" ? COLOR.calibrate
          : cell.executed === "job" ? COLOR[cell.kind ?? "relay"] : null;
        if (col) { g.fillStyle = col; g.fillRect(x, y + 1, Math.max(cw - 0.3, 1), ROW - 4); }
        if (cell.rejected) { g.fillStyle = COLOR.reject; g.fillRect(x, y, Math.max(cw, 1.5), 2); }
      }
    });
    // Правее выполненной части — будущее: приглушаем.
    const xDone = LABEL + board.executed * cw;
    if (board.executed < steps) { g.fillStyle = "rgba(0,0,0,0.55)"; g.fillRect(xDone, 0, w - xDone, sats.length * ROW); }
    const xNow = LABEL + cursor * cw;
    g.strokeStyle = "#ffffff"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xNow, 0); g.lineTo(xNow, sats.length * ROW); g.stroke();
    g.setLineDash([]);
    g.fillStyle = "#6e727a";
    for (let k = 0; k <= steps; k += 36) g.fillText(clock(k), LABEL + k * cw, sats.length * ROW + 14);
  }, [board, grid, sats, steps, cursor, selected]);

  const locate = (e: React.MouseEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const cw = (rect.width - LABEL) / steps;
    const k = Math.floor((x - LABEL) / cw), i = Math.floor(y / ROW);
    const cell = sats[i] && k >= 0 ? grid.get(`${sats[i]}|${k}`) : undefined;
    return { cell, x, y };
  };

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={ref}
        style={{ cursor: onSelect ? "pointer" : "default" }}
        onMouseMove={(e) => { const { cell, x, y } = locate(e); setHover(cell ? { cell, x, y } : null); }}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => { const { cell } = locate(e); if (cell && onSelect) onSelect(cell.satellite_id, cell.step); }}
      />
      {hover && (
        <div className="tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div><span className="id">{hover.cell.satellite_id}</span> · шаг {hover.cell.step} · {clock(hover.cell.step)}</div>
          <div>{hover.cell.executed === "job" ? <span className="id">{hover.cell.job_id}</span>
            : hover.cell.executed === "calibrate" ? "калибровка" : "ожидание"}</div>
          {hover.cell.rejected && (
            <div style={{ color: "var(--bad)" }}>отклонено: {REASON[hover.cell.reason ?? ""] ?? hover.cell.reason}</div>
          )}
          <div className="muted">заряд {hover.cell.soc.toFixed(1)}% · {hover.cell.temp.toFixed(1)} °C</div>
        </div>
      )}
    </div>
  );
}
