import { NavLink, Route, Routes } from "react-router-dom";
import Compare from "./Compare";
import DemoBoot from "./DemoBoot";
import LiveRun from "./LiveRun";
import Method from "./Method";
import MyRuns from "./MyRuns";
import Results from "./Results";
import Setup from "./Setup";
import "./console.css";

export default function Console() {
  const link = ({ isActive }: { isActive: boolean }) => (isActive ? "on" : "");
  return (
    <div className="console">
      <header className="bar">
        <NavLink to="/" className="brand"><i className="brand-dot" />Созвездие</NavLink>
        <nav className="bar-nav">
          <NavLink to="/console" end className={link}>Демо-смена</NavLink>
          <NavLink to="/console/new" className={link}>Новая смена</NavLink>
          <NavLink to="/console/runs" className={link}>Мои смены</NavLink>
          <NavLink to="/console/compare" className={link}>Сравнение</NavLink>
          <NavLink to="/console/results" className={link}>Результаты</NavLink>
          <NavLink to="/console/method" className={link}>Как это работает</NavLink>
        </nav>
      </header>
      <Routes>
        <Route index element={<DemoBoot />} />
        <Route path="demo" element={<DemoBoot fresh />} />
        <Route path="new" element={<Setup />} />
        <Route path="run/:id" element={<LiveRun />} />
        <Route path="compare" element={<Compare />} />
        <Route path="runs" element={<MyRuns />} />
        <Route path="results" element={<Results />} />
        <Route path="method" element={<Method />} />
      </Routes>
    </div>
  );
}
