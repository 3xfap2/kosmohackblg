import type { StepRow, Timeline } from "../api/types";

// Единый формат для орбиты, расписания и графика заряда. Только перекладка полей,
// никаких расчётов: всё берётся из журнала модели (trace) или его компактной формы (timeline).
export interface Cell {
  step: number; satellite_id: string;
  executed: "idle" | "calibrate" | "job";
  rejected: boolean; reason?: string;
  job_id?: string; kind?: "relay" | "downlink";
  soc: number; temp: number;
}

export interface Board {
  satellites: string[];
  steps: number;          // длина смены
  executed: number;       // сколько шагов выполнено
  cells: Cell[];
  dark: Record<string, string>;   // на все шаги смены: "1" — тень
}

const CODE: Record<string, Pick<Cell, "executed" | "kind" | "rejected">> = {
  ".": { executed: "idle", rejected: false },
  c: { executed: "calibrate", rejected: false },
  r: { executed: "job", kind: "relay", rejected: false },
  d: { executed: "job", kind: "downlink", rejected: false },
  x: { executed: "idle", rejected: true },
};

export function fromTimeline(t: Timeline): Board {
  const cells: Cell[] = [];
  t.satellites.forEach((sid, i) => {
    for (let k = 0; k < t.steps_executed; k++) {
      const c = CODE[t.action[i][k]] ?? CODE["."];
      cells.push({
        step: k, satellite_id: sid, ...c, job_id: t.job[i][k] ?? undefined,
        reason: c.rejected ? t.reasons[`${sid}|${k}`] : undefined, soc: t.soc[i][k], temp: t.temp[i][k],
      });
    }
  });
  return {
    satellites: t.satellites, steps: t.steps_total, executed: t.steps_executed, cells,
    dark: Object.fromEntries(t.satellites.map((sid, i) => [sid, t.dark[i]])),
  };
}

export function fromTrace(rows: StepRow[], kindOf: Record<string, "relay" | "downlink">, steps: number): Board {
  const satellites = [...new Set(rows.map((r) => r.satellite_id))].sort();
  const dark: Record<string, string[]> = Object.fromEntries(satellites.map((s) => [s, Array(steps).fill("0")]));
  const cells = rows.map((r): Cell => {
    if (r.solar_w === 0) dark[r.satellite_id][r.step] = "1";
    const rejected = r.requested.action !== "idle" && r.executed === "idle";
    return {
      step: r.step, satellite_id: r.satellite_id, executed: r.executed, rejected,
      reason: rejected ? r.reason : undefined, job_id: r.requested.job_id,
      kind: r.executed === "job" ? kindOf[r.requested.job_id ?? ""] : undefined,
      soc: r.soc_after_pct, temp: r.temp_after_c,
    };
  });
  const executed = rows.reduce((m, r) => Math.max(m, r.step + 1), 0);
  return { satellites, steps, executed, cells, dark: Object.fromEntries(Object.entries(dark).map(([k, v]) => [k, v.join("")])) };
}
