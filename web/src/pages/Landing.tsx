import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Constellation from "../components/Constellation";
import { Term } from "../glossary";
import { usd } from "../format";
import "./landing.css";

// Числа результата — только из results/summary.json через /api/proof (никаких чисел в тексте страницы).
interface Res { p3_done: number; p3_due: number; jobs_done: number; jobs_total: number; revenue_usd: number; blocked: number }
interface Proof {
  available: boolean; source?: string; runs?: number; replay_ok?: number; repeat_ok?: number;
  rows: ({ scenario: string; goal: string } & Record<"edf-baseline" | "goal-greedy" | "horizon-cpsat", Res | null>)[];
  events?: { goal: string; adaptive: Res; frozen: Res }[];
}
const SCEN: Record<string, string> = { P02_shift: "Обычная смена", P03_energy: "Дефицит энергии", P04_demand: "Перегрузка заданиями" };

export default function Landing() {
  const [proof, setProof] = useState<Proof | null>(null);
  useEffect(() => { fetch("/api/proof").then((r) => r.json()).then(setProof).catch(() => setProof(null)); }, []);
  const main = (r: Proof["rows"][number]) => r["horizon-cpsat"] ?? r["goal-greedy"];
  const priority = proof?.rows.filter((r) => r.goal === "priority") ?? [];

  return (
    <div className="landing">
      <header className="nav rise">
        <span className="brand"><i className="brand-dot" />Созвездие</span>
        <nav><a href="#problem">Задача</a><a href="#proof">Результаты</a><a href="#product">Консоль</a></nav>
        <Link className="btn" to="/console/new">Новая смена</Link>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow mono rise rise-1"><span className="live" />КосмоХакатон 2026 · автономное управление группировкой</p>
          <h1 className="rise rise-2">Смена из 48 спутников —<br /><em>под контролем одного оператора</em></h1>
          <p className="lead rise rise-3">
            Сервис сам распределяет задания между спутниками, следит за зарядом батарей и окнами связи, перестраивает
            план при отказах и объясняет каждую потерю, чтобы оператор видел цену решения до того, как его принять.
          </p>
          <div className="cta rise rise-4">
            <Link className="btn btn-primary btn-lg" to="/console">Открыть демо-смену <span className="arrow">→</span></Link>
            <Link className="btn btn-lg" to="/console/new">Настроить свою</Link>
          </div>
        </div>
        <div className="hero-art rise rise-3">
          <Constellation />
          <div className="hero-legend mono">
            <span><i style={{ background: "#b4a4ff" }} />ретрансляция</span>
            <span><i style={{ background: "#6cb6ff" }} />на Землю</span>
            <span><i style={{ background: "#f5c451" }} />калибровка</span>
            <span><i style={{ background: "#8b9097" }} />ждёт</span>
          </div>
        </div>
      </section>

      <section id="problem" className="block">
        <p className="kicker mono">Задача</p>
        <h2>Почему это трудно</h2>
        <div className="grid3">
          <div className="card spot fact"><b className="mono">35 из 95 мин</b><h3>Батарея садится в <Term k="shadow">тени</Term></h3>
            <p className="muted">На каждом витке спутник больше трети времени живёт без солнца. Работа в тени расходует заряд, а ниже <Term k="reserve">резерва 30 %</Term> модель запрещает задания.</p></div>
          <div className="card spot fact"><b className="mono">2 из 48</b><h3>Узкий канал на Землю</h3>
            <p className="muted">Одновременно <Term k="downlink">передавать на Землю</Term> могут только два спутника, и лишь во время своего сеанса связи.</p></div>
          <div className="card spot fact"><b className="mono">каждые 4 ч</b><h3>Обслуживание и сюрпризы</h3>
            <p className="muted">Без <Term k="calibration">калибровки</Term> спутник не работает. А во время смены приходят срочные заявки, отказы спутников и отмены сеансов связи.</p></div>
        </div>
        <div className="flow">
          <span>Планирует на 4 часа вперёд</span><i>→</i><span>Перестраивается после каждого сообщения</span><i>→</i><span>Объясняет: ограничение задачи или решение алгоритма</span>
        </div>
      </section>

      <section id="proof" className="block">
        <p className="kicker mono">Результаты</p>
        <h2>Простое правило против нашего планировщика</h2>
        <p className="muted small">Режим «Приоритетное обслуживание»: <Term k="p3">срочные задания</Term>, выполненные в срок.
          Каждый прогон исполнен <Term k="model">моделью организаторов</Term> и повторён.</p>
        {!proof && <div className="skeleton" />}
        {proof && !proof.available && <p className="muted">Результаты ещё не сгенерированы.</p>}
        {proof?.available && (
          <>
            <div className="proof-grid">
              {priority.map((r) => {
                const m = main(r)!, e = r["edf-baseline"]!;
                const d = m.p3_done - e.p3_done;
                return (
                  <div key={r.scenario} className="card proof-card">
                    <p className="muted small">{SCEN[r.scenario] ?? r.scenario} · <span className="mono">{r.scenario}</span></p>
                    <div className="proof-nums">
                      <div><span className="muted tiny">простое правило</span><b className="mono dim">{e.p3_done}<small>/{e.p3_due}</small></b></div>
                      <i>→</i>
                      <div><span className="muted tiny">наш планировщик</span><b className="mono">{m.p3_done}<small>/{m.p3_due}</small></b></div>
                    </div>
                    <p className={d > 0 ? "ok-text" : "muted small"}>{d > 0 ? `+${d} срочных заданий в срок` : "результат равен простому правилу"}</p>
                    <p className="muted tiny">выручка {usd(e.revenue_usd)} → {usd(m.revenue_usd)} · отказов модели {m.blocked}</p>
                  </div>
                );
              })}
            </div>
            {proof.events?.filter((e) => e.goal === "priority").map((e) => (
              <div key={e.goal} className="card proof-wide">
                <div>
                  <p className="muted small">Смена P02 + 4 сообщения организаторов: срочные заявки, отказ двух спутников, отмена связи</p>
                  <h3>Перестройка плана после каждого сообщения против «старого плана»</h3>
                </div>
                <div className="proof-nums">
                  <div><span className="muted tiny">старый план</span><b className="mono dim">{e.frozen.p3_done}<small>/{e.frozen.p3_due}</small></b></div>
                  <i>→</i>
                  <div><span className="muted tiny">с перестройкой</span><b className="mono">{e.adaptive.p3_done}<small>/{e.adaptive.p3_due}</small></b></div>
                  <div className="proof-side"><span className="muted tiny">выручка</span><b className="mono">{usd(e.frozen.revenue_usd)} → {usd(e.adaptive.revenue_usd)}</b></div>
                </div>
              </div>
            ))}
            <p className="proof-meta mono small">
              <span className="ok-text">✓</span> {proof.replay_ok} из {proof.runs} прогонов повторены моделью организаторов с тем же итогом ·
              <span className="ok-text"> ✓</span> {proof.repeat_ok} повторены дважды побитно · источник: <span className="id">{proof.source}</span>
            </p>
          </>
        )}
      </section>

      <section id="product" className="block">
        <p className="kicker mono">Консоль оператора</p>
        <h2>Смена как на ладони</h2>
        <Link to="/console" className="shot">
          <div className="shot-bar"><i /><i /><i /><span className="mono">созвездие · демо-смена P02</span></div>
          <img src="/product-console.png" alt="Консоль оператора: живая орбита, показатели смены и объяснение потерь" loading="lazy" />
          <span className="shot-cta btn btn-primary">Открыть демо-смену <span className="arrow">→</span></span>
        </Link>
        <div className="grid3 small-cards">
          <div className="card spot feature"><h3>Рассказ</h3><p className="muted">Нажмите «Рассказ», и смена проиграется с подписями ключевых моментов.</p></div>
          <div className="card spot feature"><h3>Почему?</h3><p className="muted">У каждой потери есть причина, у невыполнимости есть доказательство.</p></div>
          <div className="card spot feature"><h3>Что если</h3><p className="muted">Отключите спутник прямо с карты и увидите цену до того, как решение принято.</p></div>
        </div>
      </section>

      <footer className="muted">Созвездие · КосмоХакатон 2026 · расчётная модель кейса, не реальная телеметрия</footer>
    </div>
  );
}
