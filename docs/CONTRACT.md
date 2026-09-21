# Контракт ядро ↔ интерфейс (v1 — сервер без состояния)

Правило: интерфейс ничего не считает. Каждое число на экране и в выгрузке приходит
из одной функции ядра. Меняет этот файл только автор, и он сообщает второму участнику.

## Слои

```
model/        официальная библиотека организаторов — не редактируется
core/         сценарии, запуски, планировщики, события, объяснения, сравнение (без FastAPI)
api/          FastAPI без состояния: HTTP ↔ core (Vercel Function)
web/          React: экраны, графики — только отображение
experiments/  генератор results/ (детерминированно, фиксированный seed)
```

## Типы (JSON)

```ts
type Goal = "priority" | "revenue";
type Algorithm = "horizon-cpsat" | "goal-greedy" | "edf-baseline";   // основной | эвристика по цели | простое правило

// Задание в формате описания данных (раздел «Задания»).
interface Job {
  id: string; kind: "relay" | "downlink";
  release_step: number; deadline_step: number; work_steps: number;
  eligible_satellites: string[]; priority: 1 | 2 | 3; value_usd: number;
}

// Ровно то, что возвращает model.operations.Session.summary().
interface OfficialSummary {
  steps_executed: number; jobs_total: number; jobs_completed: number;
  jobs_due: number; jobs_due_missed: number;
  critical_jobs_due: number; critical_jobs_completed_on_time: number;
  revenue_usd: number; blocked_command_count: number;
  below_reserve_satellite_steps: number; brownout_satellite_steps: number;
  critical_soc_satellite_steps: number; minimum_soc_pct: number;
  terminal_soc_pct: Record<string, number>; work_steps_in_missed_jobs: number;
}

// Настройка до запуска. Изменённые условия — новый сценарий с новым id.
interface Overrides {
  initial_soc_pct?: Record<string, number>;   // заряд выбранных аппаратов, 0–100
  solar_factor?: number;                        // множитель solar_w, > 0
  job_priority?: Record<string, 1 | 2 | 3>;     // приоритет существующих заданий
}

interface ScenarioInfo {
  id: string; title: string; derived_from?: string; overrides?: Overrides;
  satellites: number; steps: number; step_s: 300; jobs: number;
  jobs_by_priority: Record<"1"|"2"|"3", number>; jobs_by_kind: Record<"relay"|"downlink", number>;
  provably_infeasible_jobs: number;            // статический анализ, см. Explanation.proof
}

interface RunView {
  id: string; scenario_id: string;
  parent?: { run_id: string; fork_step: number };
  status: "ready" | "running" | "paused" | "finished" | "error";
  progress?: { step: number; target: number };  // для долгих расчётов
  step: number; steps_total: number;
  goal: Goal; goal_history: { step: number; goal: Goal }[];
  algorithm: { name: Algorithm; version: string; parameters: Record<string, unknown> };
  summary: OfficialSummary;                      // ровно Session.summary()
  kpi: {                                         // производные, null при нулевом знаменателе
    p3_on_time_share: number | null; utilization: number | null;
    revenue_lost_in_missed_usd: number;
  };
  events: EventRecord[];                         // принятые, в порядке получения
  rejected_events: { received_at_step: number; payload: unknown; error: string }[];
}

type EventRecord =
  | { id: string; at_step: number; type: "add_jobs"; jobs: Job[] }
  | { id: string; at_step: number; type: "satellite_outage" | "close_downlink";
      satellite_ids: string[]; end_step: number };

interface JobView {
  id: string; kind: "relay" | "downlink"; priority: 1 | 2 | 3; value_usd: number;
  release_step: number; deadline_step: number; work_steps: number; done_steps: number;
  eligible_satellites: string[]; executors: string[];   // фактические исполнители
  status: "waiting" | "open" | "in_progress" | "completed" | "missed";
  completed_step: number | null; source: "plan" | string; // id события, если пришло сообщением
  loss?: LossReason;                                       // для missed
}

// Причины потерь. Две группы — главное для О3.
type LossReason =
  | { group: "problem_limit"; code: "no_contact_steps" | "insufficient_contact_steps"
        | "satellite_unavailable" | "energy_bound"; proof: string }
  | { group: "planner_choice"; code: "executor_busy" | "ground_capacity_used"
        | "energy_spent_elsewhere" | "calibration_timing" | "started_not_finished";
      evidence: string };

interface StepRow {                              // строка журнала = trace модели + пояснение планировщика
  step: number; satellite_id: string;
  requested: { action: "idle" | "calibrate" | "job"; job_id?: string };
  executed: "idle" | "calibrate" | "job"; reason: string;
  energy_before_wh: number; energy_after_wh: number; soc_after_pct: number;
  temp_before_c: number; temp_after_c: number; calibration_age_steps: number;
  completed_job: string | null; planner_note?: string;
  solar_w: number; heater_w: number; load_w: number;   // из trace модели
  below_reserve: boolean; brownout: boolean;
}

// Компактное расписание для орбиты и диаграммы: полный trace P02 — 5,8 МБ (лимит ответа Vercel 4,5 МБ),
// этот формат — ~0,3 МБ. Строки индексируются шагом 0..steps_executed-1.
interface Timeline {
  satellites: string[]; steps_total: number; steps_executed: number;
  action: string[];                 // на аппарат строка: "." ожидание, "c" калибровка, "r" relay, "d" downlink, "x" отклонено
  job: (string | null)[][];         // id задания на шаге (для "r"/"d"/"x"), иначе null
  soc: number[][];                  // заряд в конце шага, %, 1 знак
  temp: number[][];                 // температура в конце шага, °C, 1 знак
  dark: string[];                   // на все steps_total шагов: "1" — solar_w == 0 (тень), иначе "0"
  reasons: Record<string, string>;  // "S01|82" -> причина отказа модели (только для "x")
}

interface Explanation {                          // «Почему?» по заданию или аппарату/шагу
  subject: { job_id?: string; satellite_id?: string; step?: number };
  known_at_decision: string[];                   // какие сведения были доступны
  constraint: string | null;                     // какое ограничение повлияло
  consequence: string;
  loss?: LossReason;
}

interface Comparison {
  a: string; b: string; same_origin: boolean; fork_step: number | null;
  same_events_after_fork: boolean;
  metrics: { name: string; a: number | null; b: number | null; delta: number | null; better: "a" | "b" | "equal" }[];
  verdict: { goal: Goal; preferred: "a" | "b" | "comparable"; reason: string };
}
```

## Запуск без состояния на сервере (v1)

Деплой — Vercel Functions (Hobby: 1 vCPU, ≤300 с на запрос, ≤4,5 МБ тело запроса/ответа, экземпляры
не делят память). Поэтому сервер ничего не хранит. Запуск — это запись `RunRecord`: её хранит браузер
(IndexedDB) и присылает в каждом запросе. Сервер восстанавливает `Session` через
`model.operations.replay_episode` (замер: 0,2 с P02, 0,4 с P04 на 288 шагов), выполняет действие и
возвращает новую запись. Изоляция пользователей — по построению.

```ts
type ScenarioSource =
  | { ref: string; overrides?: Overrides }        // встроенный сценарий data/<ref>.json (+ производный)
  | { inline: object; overrides?: Overrides };    // загруженный пользователем JSON

interface RunRecord {
  schema: "sozvezdie-run-1";
  id: string;                                     // uuid, выдаёт сервер
  scenario: ScenarioSource;
  scenario_hash: string;                          // model.operations.digest(сценарий после overrides)
  run_metadata: {                                 // идёт в экспорт как есть
    goal: Goal; algorithm: Algorithm; version: string; parameters: Record<string, unknown>;
    goal_history: { step: number; goal: Goal }[];
    parent?: { run_id: string; fork_step: number };
  };
  events: EventRecord[];                          // принятые, в порядке получения
  rejected_events: { received_at_step: number; payload: unknown; error: string }[];
  commands: { step: number; satellite_id: string; action: string; job_id?: string }[];
  steps_executed: number;
  planner_state: unknown;                         // сериализованное состояние планировщика (JSON)
  notes: Record<string, Record<string, string>>;  // шаг -> аппарат -> пояснение планировщика
}
```

Требование к планировщику: `to_state() -> JSON` и `from_state(json)`, чтобы расчёт кусками давал
те же команды, что и расчёт одним проходом (Т4). Проверяется тестом.

## Python-интерфейс ядра (`core/service.py`)

`api/` вызывает только эти функции. Все чистые: запись на входе не меняется, возвращается новая.
Ошибки ввода — `core.errors.InputError(message)`; сообщение показывается пользователю как есть.

```python
list_scenarios() -> list[ScenarioInfo]                           # встроенные data/*.json
inspect_scenario(source: ScenarioSource) -> ScenarioInfo         # проверка через model.validate

create_run(source, goal, algorithm, parameters=None) -> RunRecord
advance(record, until_step: int, budget_s: float = 240) -> RunRecord
    # считает до until_step или пока не кончится бюджет времени; клиент повторяет вызов
apply_event(record, event) -> tuple[RunRecord, str | None]
    # отказ: возвращается запись с новой строкой rejected_events и текст ошибки; состояние не меняется
set_goal(record, goal) -> RunRecord                              # строка в goal_history
fork(record, goal=None, algorithm=None) -> RunRecord             # новый id, parent = {run_id, fork_step}

view(record) -> RunView
jobs(record, status=None, priority=None) -> list[JobView]
trace(record, step_from, step_to, satellite_id=None) -> list[StepRow]   # окно; не больше ~1 аппарата × 288 или 48 × 24
timeline(record) -> Timeline
explain(record, job_id=None, satellite_id=None, step=None) -> Explanation
compare(record_a, record_b) -> Comparison
export(record, include_trace=False) -> dict      # cosmo-B-ops-result-1.0; trace выключен — лимит 4,5 МБ
replay(result: dict) -> dict                     # {match, summary, diff}
```

## HTTP

Все запросы — POST с JSON; запись запуска передаётся в поле `run` (или `a`, `b` для сравнения).

| Путь | Тело | Ответ |
|---|---|---|
| `GET /api/scenarios` | — | `ScenarioInfo[]` |
| `/api/scenarios/inspect` | `{source}` | `ScenarioInfo` или 422 |
| `/api/runs/create` | `{source, goal, algorithm, parameters?}` | `{run, view}` |
| `/api/runs/advance` | `{run, until_step}` | `{run, view}` — может остановиться раньше, клиент повторяет |
| `/api/runs/event` | `{run, event}` | `{run, view, error}` — при отказе `error` непустой, `run` с записью отказа |
| `/api/runs/goal` | `{run, goal}` | `{run, view}` |
| `/api/runs/fork` | `{run, goal?, algorithm?}` | `{run, view}` |
| `/api/runs/view` | `{run}` | `RunView` |
| `/api/runs/jobs` | `{run, status?, priority?}` | `JobView[]` |
| `/api/runs/trace` | `{run, step_from, step_to, satellite_id?}` | `StepRow[]` |
| `/api/runs/timeline` | `{run}` | `Timeline` |
| `/api/runs/explain` | `{run, job_id?, satellite_id?, step?}` | `Explanation` |
| `/api/compare` | `{a, b}` | `Comparison` |
| `/api/runs/export` | `{run, include_trace?}` | результат `cosmo-B-ops-result-1.0` |
| `/api/replay` | результат JSON | `{match, summary, diff?}` |
