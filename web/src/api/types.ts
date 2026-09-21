// Типы из docs/CONTRACT.md. Меняются только вместе с контрактом.

export type Goal = "priority" | "revenue";
export type Algorithm = "horizon-cpsat" | "goal-greedy" | "edf-baseline";

export interface Job {
  id: string; kind: "relay" | "downlink";
  release_step: number; deadline_step: number; work_steps: number;
  eligible_satellites: string[]; priority: 1 | 2 | 3; value_usd: number;
}

export interface OfficialSummary {
  steps_executed: number; jobs_total: number; jobs_completed: number;
  jobs_due: number; jobs_due_missed: number;
  critical_jobs_due: number; critical_jobs_completed_on_time: number;
  revenue_usd: number; blocked_command_count: number;
  below_reserve_satellite_steps: number; brownout_satellite_steps: number;
  critical_soc_satellite_steps: number; minimum_soc_pct: number;
  terminal_soc_pct: Record<string, number>; work_steps_in_missed_jobs: number;
}

export interface Overrides {
  initial_soc_pct?: Record<string, number>;
  solar_factor?: number;
  job_priority?: Record<string, 1 | 2 | 3>;
}

export interface ScenarioInfo {
  id: string; title: string; derived_from?: string; overrides?: Overrides;
  satellites: number; steps: number; step_s: 300; jobs: number;
  jobs_by_priority: Record<"1" | "2" | "3", number>;
  jobs_by_kind: Record<"relay" | "downlink", number>;
  provably_infeasible_jobs: number;
}

export type EventRecord =
  | { id: string; at_step: number; type: "add_jobs"; jobs: Job[] }
  | { id: string; at_step: number; type: "satellite_outage" | "close_downlink";
      satellite_ids: string[]; end_step: number };

export interface RunView {
  id: string; scenario_id: string;
  parent?: { run_id: string; fork_step: number };
  status: "ready" | "running" | "paused" | "finished" | "error";
  progress?: { step: number; target: number };
  error?: string;
  step: number; steps_total: number;
  goal: Goal; goal_history: { step: number; goal: Goal }[];
  algorithm: { name: Algorithm; version: string; parameters: Record<string, unknown> };
  summary: OfficialSummary;
  kpi: { p3_on_time_share: number | null; utilization: number | null; revenue_lost_in_missed_usd: number };
  events: EventRecord[];
  rejected_events: { received_at_step: number; payload: unknown; error: string }[];
}

export type LossReason =
  | { group: "problem_limit"; code: "no_contact_steps" | "insufficient_contact_steps"
        | "satellite_unavailable" | "energy_bound"; proof: string }
  | { group: "planner_choice"; code: "executor_busy" | "ground_capacity_used"
        | "energy_spent_elsewhere" | "calibration_timing" | "started_not_finished"; evidence: string };

export interface JobView {
  id: string; kind: "relay" | "downlink"; priority: 1 | 2 | 3; value_usd: number;
  release_step: number; deadline_step: number; work_steps: number; done_steps: number;
  eligible_satellites: string[]; executors: string[];
  status: "waiting" | "open" | "in_progress" | "completed" | "missed";
  completed_step: number | null; source: string;
  loss?: LossReason;
}

export interface StepRow {
  step: number; satellite_id: string;
  requested: { action: "idle" | "calibrate" | "job"; job_id?: string };
  executed: "idle" | "calibrate" | "job"; reason: string;
  energy_before_wh: number; energy_after_wh: number; soc_after_pct: number;
  temp_before_c: number; temp_after_c: number; calibration_age_steps: number;
  completed_job: string | null; planner_note?: string;
  solar_w: number; heater_w: number; load_w: number;
  below_reserve: boolean; brownout: boolean;
}

export interface Timeline {
  satellites: string[]; steps_total: number; steps_executed: number;
  action: string[];
  job: (string | null)[][];
  soc: number[][];
  temp: number[][];
  dark: string[];
  reasons: Record<string, string>;
}

export interface Explanation {
  subject: { job_id?: string; satellite_id?: string; step?: number };
  known_at_decision: string[];
  constraint: string | null;
  consequence: string;
  loss?: LossReason;
}

export interface Comparison {
  a: string; b: string; same_origin: boolean; fork_step: number | null;
  same_events_after_fork: boolean;
  metrics: { name: string; a: number | null; b: number | null; delta: number | null; better: "a" | "b" | "equal" }[];
  verdict: { goal: Goal; preferred: "a" | "b" | "comparable"; reason: string };
}

export type ScenarioSource =
  | { ref: string; overrides?: Overrides }
  | { inline: object; overrides?: Overrides };

// Запись запуска: хранится в браузере, сервер её не хранит (docs/CONTRACT.md, v1).
export interface RunRecord {
  schema: "sozvezdie-run-1";
  id: string;
  scenario: ScenarioSource;
  scenario_hash: string;
  run_metadata: {
    goal: Goal; algorithm: Algorithm; version: string; parameters: Record<string, unknown>;
    goal_history: { step: number; goal: Goal }[];
    parent?: { run_id: string; fork_step: number };
  };
  events: EventRecord[];
  rejected_events: { received_at_step: number; payload: unknown; error: string }[];
  commands: { step: number; satellite_id: string; action: string; job_id?: string }[];
  steps_executed: number;
  planner_state: unknown;
  notes: Record<string, Record<string, string>>;
}

export interface RunResponse { run: RunRecord; view: RunView; error?: string | null; suggested_events?: EventRecord[] }

// ---------- Функции О7 (core/features.py) ----------
export interface BranchScore {
  p3_due: number; p3_done: number; jobs_due: number; jobs_done: number;
  revenue_usd: number; below_reserve_steps: number; blocked_commands: number;
}
export interface BriefJob { id: string; priority: number; value_usd: number; kind: string; done?: boolean }
export interface ScoreDelta { p3_done: number; jobs_done: number; revenue_usd: number; below_reserve_steps: number }
export interface Impact {
  from_step: number; until_step: number; algorithm: string; event_id: string;
  without_event: BranchScore; replanned: BranchScore; old_plan: BranchScore;
  cost_of_event: ScoreDelta; saved_by_replanning: ScoreDelta;
  new_jobs: BriefJob[]; displaced: BriefJob[]; saved_jobs: BriefJob[]; note: string;
}
export interface Alert { kind: "energy" | "p3" | "calibration"; severity: "high" | "medium" | "low"; step: number; text: string; satellite_id?: string; job_id?: string }
export interface Forecast { from_step: number; until_step: number; alerts: Alert[]; summary: BranchScore; note: string }
export interface WhyNot {
  job_id: string; verdict: "impossible" | "possible" | "not_found" | "completed";
  proof?: { code: string; proof: string }; completed_step?: number | null; window?: [number, number];
  displaced?: BriefJob[]; gained?: BriefJob[]; note?: string;
}
export interface ShiftResult { p3_done: number; p3_due: number; jobs_done: number; jobs_total: number; revenue_usd: number; below_reserve_steps: number; min_soc_pct: number }
export interface WhatIf { goal: string; base: ShiftResult & { label: string }; variants: (ShiftResult & { label: string; kind: string; delta: { p3_done: number; jobs_done: number; revenue_usd: number } })[]; note: string }
export interface Frontier { points: (ShiftResult & { p3_bonus_usd: number; dominated: boolean })[]; note: string }
export interface Stress {
  seed: number; runs: number; wins: number;
  rows: { run: number; events: number; ours: ShiftResult; baseline: ShiftResult }[];
  ours: Record<"p3_done" | "revenue_usd", { min: number; median: number; max: number }>;
  baseline: Record<"p3_done" | "revenue_usd", { min: number; median: number; max: number }>; note: string;
}
export interface Link { steps: number; executed: number; contact_share: number; used_share_executed: number | null;
  dark_windows: { start: number; end: number; steps: number; future: boolean }[]; longest_dark_steps: number; note: string }
export interface Passport { satellite_id: string; capacity_wh: number; soc_now_pct: number; soc_min_pct: number | null; soc_depth_pct: number | null;
  below_reserve_steps: number; heater_steps: number; job_steps: number; calibrations: number[]; rejected: number; calibration_due_step: number; temp_now_c: number }
export interface Report { markdown: string }
