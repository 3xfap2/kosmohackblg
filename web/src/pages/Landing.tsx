import { Link } from "react-router-dom";
import Constellation from "../components/Constellation";
import "./landing.css";

// Тексты без чисел результата: они появятся из results/summary.json после экспериментов.
export default function Landing() {
  return (
    <div className="landing">
      <header className="nav">
        <span className="brand">Созвездие</span>
        <nav><a href="#how">Как работает</a><a href="#proof">Проверка</a></nav>
        <Link className="btn" to="/console">Открыть консоль</Link>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow mono">КосмоХакатон 2026 · автономное управление группировкой</p>
          <h1>Смена из 48 аппаратов — под контролем одного оператора</h1>
          <p className="lead muted">
            Планировщик распределяет задания с учётом заряда, температуры, калибровки и окон связи,
            перестраивает план при отказах и объясняет каждую потерю.
          </p>
          <Link className="btn btn-primary" to="/console">Запустить смену</Link>
        </div>
        <div className="hero-art"><Constellation /></div>
      </section>

      <section id="how" className="grid3">
        <div className="card"><h3>Планирует наперёд</h3><p className="muted">Решает, на какие задания потратить заряд до входа в тень, а не только что делать сейчас.</p></div>
        <div className="card"><h3>Перестраивается</h3><p className="muted">Срочная заявка, отказ аппарата, отмена сеанса — план продолжается из фактического состояния.</p></div>
        <div className="card"><h3>Объясняет</h3><p className="muted">Отделяет ограничения задачи от решений алгоритма. Невыполнимость — с доказательством.</p></div>
      </section>

      <section id="proof" className="card proof">
        <p className="mono muted">$ python model/operations.py --result run.json</p>
        <p className="mono"><span style={{ color: "var(--ok)" }}>✓</span> любой расчёт воспроизводится моделью организаторов</p>
      </section>

      <footer className="muted">Созвездие · расчётная модель кейса, не реальная телеметрия</footer>
    </div>
  );
}
