import type {
  Algorithm, Comparison, Explanation, Goal, JobView, RunRecord, RunResponse, RunView,
  ScenarioInfo, ScenarioSource, StepRow, Timeline,
  Forecast, Frontier, Impact, Link, Passport, Report, Stress, Tournament, WhatIf, WhyNot,
} from "./types";

// Тот же домен: на Vercel /api — Python-функция, локально — прокси Vite.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function req<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Ошибка сервера ${res.status}`;
    if (res.status === 413) msg = "Слишком большой запрос: запись смены больше лимита сервера (на Vercel — 4,5 МБ)";
    try {
      const data = await res.json();
      if (typeof data.detail === "string") msg = data.detail;
    } catch { /* ответ без JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  scenarios: () => req<ScenarioInfo[]>("/api/scenarios"),
  inspect: (source: ScenarioSource) => req<ScenarioInfo>("/api/scenarios/inspect", { source }),

  create: (source: ScenarioSource, goal: Goal, algorithm: Algorithm) =>
    req<RunResponse>("/api/runs/create", { source, goal, algorithm }),
  advance: (run: RunRecord, until_step: number) => req<RunResponse>("/api/runs/advance", { run, until_step }),
  event: (run: RunRecord, event: unknown) => req<RunResponse>("/api/runs/event", { run, event }),
  setGoal: (run: RunRecord, goal: Goal) => req<RunResponse>("/api/runs/goal", { run, goal }),
  fork: (run: RunRecord, goal?: Goal, algorithm?: Algorithm) => req<RunResponse>("/api/runs/fork", { run, goal, algorithm }),

  view: (run: RunRecord) => req<RunView>("/api/runs/view", { run }),
  jobs: (run: RunRecord, status?: string, priority?: number) => req<JobView[]>("/api/runs/jobs", { run, status, priority }),
  trace: (run: RunRecord, step_from: number, step_to: number, satellite_id?: string) =>
    req<StepRow[]>("/api/runs/trace", { run, step_from, step_to, satellite_id }),
  timeline: (run: RunRecord) => req<Timeline>("/api/runs/timeline", { run }),
  explain: (run: RunRecord, p: { job_id?: string; satellite_id?: string; step?: number }) =>
    req<Explanation>("/api/runs/explain", { run, ...p }),
  compare: (a: RunRecord, b: RunRecord) => req<Comparison>("/api/compare", { a, b }),
  export: (run: RunRecord, include_trace = false) => req<unknown>("/api/runs/export", { run, include_trace }),
  f: {
    impact: (run: RunRecord, event: unknown) => req<Impact>("/api/features/impact", { run, event }),
    forecast: (run: RunRecord) => req<Forecast>("/api/features/forecast", { run }),
    whyNot: (run: RunRecord, job_id: string) => req<WhyNot>("/api/features/why-not", { run, job_id }),
    whatIf: (run: RunRecord) => req<WhatIf>("/api/features/what-if", { run }),
    frontier: (run: RunRecord) => req<Frontier>("/api/features/frontier", { run }),
    stress: (run: RunRecord, runs = 12) => req<Stress>("/api/features/stress", { run, runs }),
    link: (run: RunRecord) => req<Link>("/api/features/link", { run }),
    tournament: (run: RunRecord) => req<Tournament>("/api/features/tournament", { run }),
    passport: (run: RunRecord, satellite_id: string) => req<Passport>("/api/features/passport", { run, satellite_id }),
    report: (run: RunRecord) => req<Report>("/api/features/report", { run }),
  },
  demo: () => req<RunResponse>("/api/demo", {}),
  aiStatus: () => req<{ enabled: boolean; model: string | null }>("/api/ai/status"),
  ask: (run: RunRecord, question: string) =>
    req<{ answer: string; source: "ai" | "template" | "template_after_check" }>("/api/ai/ask", { run, question }),
  draftEvent: (run: RunRecord, text: string) =>
    req<{ event: Record<string, unknown> | null; error: string | null; note?: string }>("/api/ai/event", { run, text }),
  verify: (run: RunRecord) => req<{ match: boolean; diff?: unknown }>("/api/runs/verify", { run }),
  // Выгрузка байт в байт как её отдал сервер: разбор в JavaScript потерял бы «.0» у чисел.
  exportText: async (run: RunRecord) => {
    const res = await fetch(BASE + "/api/runs/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run }) });
    if (!res.ok) throw new ApiError(res.status, `Ошибка сервера ${res.status}`);
    return res.text();
  },
  replay: (result: unknown) => req<{ match: boolean; summary: unknown; diff?: unknown }>("/api/replay", result),
};

// Расчёт до шага: сервер считает в пределах бюджета времени, клиент повторяет вызов.
export async function advanceUntil(
  run: RunRecord, until: number, onProgress: (r: RunResponse) => void, signal?: AbortSignal,
): Promise<RunResponse> {
  let res: RunResponse = { run, view: await api.view(run) };
  while (res.run.steps_executed < until) {
    if (signal?.aborted) break;
    const before = res.run.steps_executed;
    res = await api.advance(res.run, until);
    onProgress(res);
    if (res.run.steps_executed === before) throw new ApiError(500, "Расчёт не продвинулся — повторите или сообщите об ошибке");
  }
  return res;
}

// Смена, рассчитанная прежней версией алгоритма, не продолжается (версия — часть воспроизводимости).
// Пересчёт: тот же сценарий, начальная цель и алгоритм; те же принятые сообщения и смены цели на тех же шагах;
// до того же шага. Отклонённые сообщения не повторяются. Идентификатор и родитель ветви сохраняются.
// Неверная подпись (сменился ключ сервера или запись правили вручную) — тоже пересчёт: смена считается заново
// на сервере из сценария и принятых сообщений, поэтому подменённые итоги в новую запись не попадают.
export const isStaleVersion = (e: unknown) => /Версия планировщика изменилась|Подпись записи не совпадает/.test(String((e as Error)?.message ?? e));

export async function rebuildRun(old: RunRecord, onProgress?: (step: number) => void): Promise<RunResponse> {
  const meta = old.run_metadata;
  const history = meta.goal_history ?? [];
  let res = await api.create(old.scenario, history[0]?.goal ?? meta.goal, meta.algorithm);
  const steps = [
    ...old.events.map((e) => ({ step: e.at_step, apply: (r: RunRecord) => api.event(r, e) })),
    ...history.slice(1).map((g) => ({ step: g.step, apply: (r: RunRecord) => api.setGoal(r, g.goal) })),
  ].sort((a, b) => a.step - b.step);
  const progress = (r: RunResponse) => onProgress?.(r.run.steps_executed);
  for (const s of steps) {
    if (res.run.steps_executed < s.step) res = await advanceUntil(res.run, s.step, progress);
    res = await s.apply(res.run);
  }
  if (res.run.steps_executed < old.steps_executed) res = await advanceUntil(res.run, old.steps_executed, progress);
  // id и parent — метки браузера, в подпись не входят
  const run = { ...res.run, id: old.id, run_metadata: { ...res.run.run_metadata, parent: meta.parent } };
  return { run, view: await api.view(run) };
}
