import type { Cell } from "../lib/cells";
import { clock } from "../format";

// Температура одного аппарата по шагам (ТЗ: «графики заряда и температуры»). Пунктиры — допустимый
// диапазон полезной нагрузки из модели кейса; вне его модель не допускает задания и калибровку.
export default function TempChart({ cells, dark, steps, min = -5, max = 45 }: {
  cells: Cell[]; dark: string; steps: number; min?: number; max?: number;
}) {
  const W = 1000, H = 150, P = 34;
  const lo = Math.min(min - 5, ...cells.map((c) => c.temp)), hi = Math.max(max + 5, ...cells.map((c) => c.temp));
  const x = (k: number) => P + (k / steps) * (W - P - 8);
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo)) * (H - 28);
  const line = cells.map((c, i) => `${i ? "L" : "M"}${x(c.step + 1).toFixed(1)},${y(c.temp).toFixed(1)}`).join("");
  const shadow = [...dark].map((d, k) => (d === "1" ? k : -1)).filter((k) => k >= 0);
  const ticks = [min, Math.round((min + max) / 2), max];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img"
      aria-label="График температуры аппарата">
      {shadow.map((k) => <rect key={k} x={x(k)} y={8} width={x(1) - x(0) + 0.5} height={H - 28} fill="#0b0e14" />)}
      {ticks.map((v) => (
        <g key={v}>
          <line x1={P} x2={W - 8} y1={y(v)} y2={y(v)} stroke={v === min || v === max ? "#ff9592" : "#292d30"}
            strokeDasharray={v === min || v === max ? "4 4" : undefined} />
          <text x={2} y={y(v) + 4} fill="#6e727a" fontSize="11" fontFamily="JetBrains Mono">{v}°</text>
        </g>
      ))}
      <path d={line} fill="none" stroke="#6cb6ff" strokeWidth="1.5" />
      {[0, 72, 144, 216, 288].filter((k) => k <= steps).map((k) => (
        <text key={k} x={x(k)} y={H - 4} fill="#6e727a" fontSize="11" fontFamily="JetBrains Mono" textAnchor="middle">{clock(k)}</text>
      ))}
    </svg>
  );
}
