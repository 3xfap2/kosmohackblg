import type { BranchScore, Impact } from "../api/types";
import { clock, usd } from "../format";

// F1 + F3: три продолжения из одного состояния. Вывод формулируется словами — «что сохранено».


export default function ImpactCard({ r }: { r: Impact }) {
  const s = r.saved_by_replanning, c = r.cost_of_event;
  const cost = c.p3_done < 0 || c.revenue_usd < 0
    ? `Событие стоит ${-c.p3_done} заданий P3 и ${usd(-c.revenue_usd)}`
    : c.p3_done > 0 || c.revenue_usd > 0 ? `С событием выполним на ${c.p3_done} P3 больше (+${usd(c.revenue_usd)})` : "Событие не меняет итог окна";
  const parts = [s.p3_done > 0 ? `${s.p3_done} срочных заданий` : "", s.revenue_usd > 0 ? usd(s.revenue_usd) : ""].filter(Boolean).join(" и ");
  const saved = s.p3_done > 0 || s.revenue_usd > 0
    ? `перестройка сохранила ${parts} против старого плана`
    : s.p3_done < 0 || s.revenue_usd < 0
      ? "старый план на этом окне дал бы больше"
      : r.old_plan.blocked_commands > r.replanned.blocked_commands
        ? `перестройка даёт тот же итог без ${r.old_plan.blocked_commands} команд, которые модель отклонила бы в старом плане`
        : "перестройка итог не меняет — потери вызваны самим событием";
  const headline = `${cost}; ${saved}.`;
  const cols: [string, BranchScore, string][] = [
    ["Без события", r.without_event, "muted"], ["План не меняли", r.old_plan, "bad"], ["Перестроили", r.replanned, "ok"],
  ];
  return (
    <div className="impact">
      <p className="impact-head">{headline}</p>
      <p className="muted tiny mono">окно {clock(r.from_step)}–{clock(r.until_step)} · задания со сроком в этом окне · {r.algorithm}</p>
      <div className="impact-grid">
        <span />
        {cols.map(([t, , c]) => <b key={t} className={"impact-col " + c}>{t}</b>)}
        {([["P3 в срок", (x: BranchScore) => `${x.p3_done}/${x.p3_due}`], ["Выполнено", (x: BranchScore) => `${x.jobs_done}/${x.jobs_due}`],
          ["Выручка", (x: BranchScore) => usd(x.revenue_usd)], ["Ниже резерва", (x: BranchScore) => `${x.below_reserve_steps}`],
          ["Отказы модели", (x: BranchScore) => `${x.blocked_commands}`]] as [string, (x: BranchScore) => string][]).map(([label, f]) => (
          <div key={label} className="impact-row">
            <span className="muted">{label}</span>
            {cols.map(([t, x]) => <span key={t} className="mono">{f(x)}</span>)}
          </div>
        ))}
      </div>
      {r.new_jobs.length > 0 && (
        <p className="small">Новые задания: {r.new_jobs.map((j) => (
          <span key={j.id} className={"pill " + (j.done ? "ok" : "bad")}>{j.id} {j.done ? "успеем" : "не успеем"}</span>))}</p>
      )}
      {r.displaced.length > 0 && (
        <p className="small">Вытеснит: {r.displaced.map((j) => <span key={j.id} className="pill warn">{j.id} · P{j.priority} · {usd(j.value_usd)}</span>)}</p>
      )}
      <p className="muted tiny">{r.note}</p>
    </div>
  );
}
