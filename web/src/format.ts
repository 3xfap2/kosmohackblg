// Подписи для кодов ядра и модели. Только текст — никаких расчётов.

export const REASON: Record<string, string> = {
  accepted: "принято",
  idle: "ожидание",
  satellite_unavailable: "аппарат недоступен",
  unknown_job: "неизвестное задание",
  already_completed: "задание уже выполнено",
  outside_job_window: "вне окна задания",
  ineligible_satellite: "недопустимый исполнитель",
  no_contact: "нет контакта",
  calibration_required: "нужна калибровка",
  energy_reserve: "ниже резерва заряда",
  thermal_limit: "вне температурного диапазона",
  duplicate_job_in_step: "задание уже взято на этом шаге",
  ground_capacity: "канал на Землю занят (лимит 2)",
};

export const LOSS: Record<string, string> = {
  no_contact_steps: "в окне нет шагов с контактом",
  insufficient_contact_steps: "в окне мало шагов с контактом",
  satellite_unavailable: "исполнители недоступны всё окно",
  energy_bound: "не хватает энергии при любом плане",
  executor_busy: "исполнитель занят другим заданием",
  ground_capacity_used: "канал на Землю занят другими",
  energy_spent_elsewhere: "заряд потрачен на другие задания",
  calibration_timing: "калибровка не вовремя",
  started_not_finished: "начато, но не завершено",
};

export const GROUP: Record<string, string> = {
  problem_limit: "ограничение задачи",
  planner_choice: "решение алгоритма",
};

export const STATUS: Record<string, string> = {
  waiting: "ещё не открыто",
  open: "открыто",
  in_progress: "в работе",
  completed: "выполнено",
  missed: "просрочено",
};

export const GOAL: Record<string, string> = {
  priority: "Приоритетное обслуживание",
  revenue: "Коммерческая отдача",
};

export const ALGO: Record<string, string> = {
  "horizon-cpsat": "Эвристика + CP-SAT на 4 часа вперёд",
  "goal-greedy": "Эвристика по цели (без CP-SAT)",
  "edf-baseline": "Простое правило: ближайший срок",
};

export const usd = (x: number) => "$" + Math.round(x).toLocaleString("ru-RU");
export const pct = (x: number | null | undefined) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
export const clock = (step: number) => {
  const m = step * 5;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export const EVENT_TYPE: Record<string, string> = {
  add_jobs: "новые задания",
  satellite_outage: "отказ спутников",
  close_downlink: "отмена сеансов связи с Землёй",
};

export const KIND: Record<string, string> = { downlink: "на Землю", relay: "ретрансляция" };
