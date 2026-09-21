import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";

// Подсветка вслед за курсором у карточек .spot: координаты — в CSS-переменные.
document.addEventListener("pointermove", (e) => {
  const el = (e.target as HTMLElement | null)?.closest?.(".spot") as HTMLElement | null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  el.style.setProperty("--mx", `${e.clientX - r.left}px`);
  el.style.setProperty("--my", `${e.clientY - r.top}px`);
}, { passive: true });
import Landing from "./pages/Landing";
import Console from "./pages/Console";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/console/*" element={<Console />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
