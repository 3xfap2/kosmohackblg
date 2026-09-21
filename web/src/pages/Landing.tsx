import { Link } from "react-router-dom";
import Constellation from "../components/Constellation";
import "./landing.css";

// Тексты без чисел результата: они появятся из results/summary.json после экспериментов.
const FEATURES = [
  { n: "01", title: "Планирует наперёд", text: "Решает, на какие задания потратить заряд до входа в тень, а не только что делать сейчас." },
  { n: "02", title: "Перестраивается", text: "Срочная заявка, отказ аппарата, отмена сеанса — смена продолжается из фактического состояния." },
  { n: "03", title: "Объясняет", text: "Отделяет ограничения задачи от решений алгоритма. Невыполнимость — с доказательством." },
];

export default function Landing() {
  return (
    <div className="landing">
      <header className="nav rise">
        <span className="brand"><i className="brand-dot" />Созвездие</span>
        <nav><a href="#how">Как работает</a><a href="#proof">Проверка</a></nav>
        <Link className="btn" to="/console/new">Новая смена</Link>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow mono rise rise-1"><span className="live" />КосмоХакатон 2026 · автономное управление группировкой</p>
          <h1 className="rise rise-2">Смена из 48 спутников —<br /><em>под контролем одного оператора</em></h1>
          <p className="lead rise rise-3">
            Планировщик распределяет задания с учётом заряда, температуры, калибровки и окон связи,
            перестраивает план при отказах и объясняет каждую потерю.
          </p>
          <div className="cta rise rise-4">
            <Link className="btn btn-primary btn-lg" to="/console">Открыть демо-смену <span className="arrow">→</span></Link>
            <Link className="btn btn-lg" to="/console/new">Настроить свою</Link>
          </div>
        </div>
        <div className="hero-art rise rise-3"><Constellation /></div>
      </section>

      <section id="how" className="grid3">
        {FEATURES.map((f, i) => (
          <div key={f.n} className={`card spot feature rise rise-${i + 2}`}>
            <span className="mono feature-n">{f.n}</span>
            <h3>{f.title}</h3>
            <p className="muted">{f.text}</p>
          </div>
        ))}
      </section>

      <section id="proof" className="terminal">
        <div className="terminal-bar"><i /><i /><i /><span className="mono">проверка результата</span></div>
        <pre className="mono">
          <span className="muted">$</span> python model/operations.py --result sozvezdie_run.json{"\n"}
          <span className="ok">✓</span> расчёт повторён моделью организаторов{"\n"}
          <span className="ok">✓</span> команды, сообщения и сводка совпадают
        </pre>
      </section>

      <footer className="muted">Созвездие · расчётная модель кейса, не реальная телеметрия</footer>
    </div>
  );
}
