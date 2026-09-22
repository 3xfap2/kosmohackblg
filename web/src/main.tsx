import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";

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
