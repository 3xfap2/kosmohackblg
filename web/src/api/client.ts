import type {
  Algorithm, Comparison, Explanation, Goal, JobView, Overrides, RunView, ScenarioInfo, StepRow,
} from "./types";

// Базовый адрес API. На Vercel задаётся VITE_API_URL, локально — прокси Vite.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    let msg = `Ошибка ${res.status}`;
    try {
      const body = await res.json();
      if (typeof body.detail === "string") msg = body.detail;
    } catch { /* ответ без JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown) => req<T>(path, { method: "POST", body: JSON.stringify(body) });
const qs = (p: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();

export const api = {
  scenarios: () => req<ScenarioInfo[]>("/api/scenarios"),
  uploadScenario: (raw: unknown) => post<ScenarioInfo>("/api/scenarios", raw),
  derive: (id: string, o: Overrides) => post<ScenarioInfo>(`/api/scenarios/${id}/derive`, o),

  runs: () => req<RunView[]>("/api/runs"),
  createRun: (scenario_id: string, goal: Goal, algorithm: Algorithm) =>
    post<RunView>("/api/runs", { scenario_id, goal, algorithm }),
  run: (id: string) => req<RunView>(`/api/runs/${id}`),
  advance: (id: string, until_step?: number) => post<RunView>(`/api/runs/${id}/advance`, { until_step }),
  event: (id: string, event: unknown) => post<RunView>(`/api/runs/${id}/events`, event),
  setGoal: (id: string, goal: Goal) => post<RunView>(`/api/runs/${id}/goal`, { goal }),
  fork: (id: string, goal?: Goal, algorithm?: Algorithm) => post<RunView>(`/api/runs/${id}/fork`, { goal, algorithm }),

  jobs: (id: string, status?: string, priority?: number) =>
    req<JobView[]>(`/api/runs/${id}/jobs?${qs({ status, priority })}`),
  trace: (id: string, step_from: number, step_to: number, satellite_id?: string) =>
    req<StepRow[]>(`/api/runs/${id}/trace?${qs({ step_from, step_to, satellite_id })}`),
  explain: (id: string, p: { job_id?: string; satellite_id?: string; step?: number }) =>
    req<Explanation>(`/api/runs/${id}/explain?${qs(p)}`),
  compare: (a: string, b: string) => req<Comparison>(`/api/compare?${qs({ a, b })}`),
  exportUrl: (id: string) => `${BASE}/api/runs/${id}/export`,
  replay: (result: unknown) => post<{ match: boolean; summary: unknown; diff?: unknown }>("/api/replay", result),
};
