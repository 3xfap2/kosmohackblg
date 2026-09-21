# Контракт ядро ↔ интерфейс (черновик v0)

Правило: интерфейс ничего не считает. Каждое число на экране и в выгрузке приходит
из одной функции ядра. Меняет этот файл только автор, и он сообщает второму участнику.

## Слои

```
model/        официальная библиотека организаторов — не редактируется
core/         сценарии, запуски, планировщики, события, объяснения, сравнение (без FastAPI)
api/          FastAPI: HTTP ↔ core, фоновые расчёты, изоляция запусков
web/          React: экраны, графики — только отображение
experiments/  генератор results/ (детерминированно, фиксированный seed)
```

## Типы (JSON)

```ts
type Goal = "priority" | "revenue";
type Algorithm = "horizon-cpsat" | "edf-baseline";

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

## HTTP

| Метод | Путь | Вход | Выход |
|---|---|---|---|
| GET | `/api/scenarios` | — | `ScenarioInfo[]` |
| POST | `/api/scenarios` | JSON сценария (файл) | `ScenarioInfo` или 422 с причиной |
| POST | `/api/scenarios/{id}/derive` | `Overrides` | новый `ScenarioInfo` |
| POST | `/api/runs` | `{scenario_id, goal, algorithm, parameters?}` | `RunView` |
| POST | `/api/runs/{id}/advance` | `{until_step}` или `{steps}` | `RunView` (status=running, опрос) |
| GET | `/api/runs/{id}` | — | `RunView` |
| POST | `/api/runs/{id}/events` | один объект события | `RunView` или 422, состояние не меняется |
| POST | `/api/runs/{id}/goal` | `{goal}` | `RunView` (запись в goal_history) |
| POST | `/api/runs/{id}/fork` | `{goal?, algorithm?}` | `RunView` новой ветви |
| GET | `/api/runs/{id}/jobs` | фильтры | `JobView[]` |
| GET | `/api/runs/{id}/trace` | `from, to, satellite_id?` | `StepRow[]` |
| GET | `/api/runs/{id}/explain` | `job_id` или `satellite_id+step` | `Explanation` |
| GET | `/api/compare` | `a, b` | `Comparison` |
| GET | `/api/runs/{id}/export` | — | результат `cosmo-B-ops-result-1.0` (+ поля команды) |
| POST | `/api/replay` | результат JSON | `{match: boolean, summary, diff?}` |

Изоляция: запуск принадлежит сессии браузера (cookie), чужие запуски не видны.

## Python-интерфейс ядра (`core/service.py`)

`api/` вызывает только эти функции. Возвращаются словари ровно в форме типов выше.
Ошибки ввода — `core.errors.InputError(message)`; сообщение показывается пользователю как есть,
состояние при этом не меняется. Неизвестный id — `core.errors.NotFound`.

```python
list_scenarios() -> list[ScenarioInfo]
add_scenario(raw: dict) -> ScenarioInfo                         # проверка через model.validate
derive_scenario(scenario_id: str, overrides: Overrides) -> ScenarioInfo

create_run(scenario_id: str, goal: Goal, algorithm: Algorithm,
           parameters: dict | None = None) -> RunView
advance(run_id: str, until_step: int,
        on_progress: Callable[[int], None] | None = None) -> RunView  # блокирующий; api запускает в фоне
apply_event(run_id: str, event: dict) -> RunView                # отказ -> InputError + запись в rejected_events
set_goal(run_id: str, goal: Goal) -> RunView
fork(run_id: str, goal: Goal | None = None, algorithm: Algorithm | None = None) -> RunView
get_run(run_id: str) -> RunView

jobs(run_id: str, status: str | None = None, priority: int | None = None) -> list[JobView]
trace(run_id: str, step_from: int, step_to: int, satellite_id: str | None = None) -> list[StepRow]
explain(run_id: str, job_id: str | None = None,
        satellite_id: str | None = None, step: int | None = None) -> Explanation
compare(run_a: str, run_b: str) -> Comparison
export(run_id: str) -> dict                                     # cosmo-B-ops-result-1.0
replay(result: dict) -> dict                                    # {match, summary, diff}
```

Хранение — в памяти процесса (словари по id). Владение запусками и cookie — забота `api/`.
