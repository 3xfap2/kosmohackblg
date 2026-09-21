import type { StepRow } from "../api/types";
import { clock } from "../format";

// Заряд одного аппарата по шагам. Пунктиры — резерв 30 % (допуск операций) и критический 20 %.
// Тёмные полосы — тень (solar_w = 0), жёлтые засечки — калибровки.
export default function SocChart({ rows, steps, reserve = 30, critical = 20 }: {
  rows: StepRow[]; steps: number; reserve?: number; critical?: number;
}) {
  const W = 1000, H = 180, P = 28;
  const x = (k: number) => P + (k / steps) * (W - P - 8);
  const y = (v: number) => 8 + (1 - v / 100) * (H - P);
  const line = rows.map((r, i) => `${i ? "L" : "M"}${x(r.step + 1).toFixed(1)},${y(r.soc_after_pct).toFixed(1)}`).join("");
  const shadow = rows.filter((r) => r.solar_w === 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img"
      aria-label="График заряда аппарата">
      {shadow.map((r) => <rect key={r.step} x={x(r.step)} y={8} width={x(1) - x(0) + 0.5} height={H - P} fill="#0b0e14" />)}
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line x1={P} x2={W - 8} y1={y(v)} y2={y(v)} stroke="#292d30" />
          <text x={2} y={y(v) + 4} fill="#6e727a" fontSize="11" fontFamily="JetBrains Mono">{v}%</text>
        </g>
      ))}
      <line x1={P} x2={W - 8} y1={y(reserve)} y2={y(reserve)} stroke="#ffca16" strokeDasharray="4 4" />
      <line x1={P} x2={W - 8} y1={y(critical)} y2={y(critical)} stroke="#ff9592" strokeDasharray="4 4" />
      {rows.filter((r) => r.executed === "calibrate").map((r) => (
        <line key={r.step} x1={x(r.step)} x2={x(r.step)} y1={H - P} y2={H - P + 6} stroke="#ffca16" />
      ))}
      <path d={line} fill="none" stroke="#f0f0f0" strokeWidth="1.5" />
      {[0, 72, 144, 216, 288].filter((k) => k <= steps).map((k) => (
        <text key={k} x={x(k)} y={H - 4} fill="#6e727a" fontSize="11" fontFamily="JetBrains Mono" textAnchor="middle">{clock(k)}</text>
      ))}
    </svg>
  );
}
