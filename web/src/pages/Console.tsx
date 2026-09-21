import { Link, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import Compare from "./Compare";
import Demo from "./Demo";
import LiveRun from "./LiveRun";
import Setup from "./Setup";
import "./console.css";

export default function Console() {
  const [params] = useSearchParams();
  const legacyDemo = params.get("demo");
  return (
    <div className="console">
      <header className="bar">
        <Link to="/" className="brand">Созвездие</Link>
        <nav className="bar-nav">
          <Link to="/console">Смены</Link>
          <Link to="/console/compare">Сравнение</Link>
          <Link to="/console/demo/edf-baseline">Демо</Link>
        </nav>
      </header>
      <Routes>
        <Route index element={legacyDemo ? <Navigate to={`demo/${legacyDemo}?${params}`} replace /> : <Setup />} />
        <Route path="run/:id" element={<LiveRun />} />
        <Route path="compare" element={<Compare />} />
        <Route path="demo/:alg" element={<Demo />} />
      </Routes>
    </div>
  );
}
