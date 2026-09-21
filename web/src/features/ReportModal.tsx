import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { RunRecord } from "../api/types";

// F10: отчёт о передаче смены — цифры и причины из ядра, одним документом.
export default function ReportModal({ run, onClose }: { run: RunRecord; onClose: () => void }) {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.f.report(run).then((r) => setMd(r.markdown)).catch((e) => setError(e.message)); }, [run]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc); return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([md ?? ""], { type: "text/markdown" }));
    Object.assign(document.createElement("a"), { href: url, download: `smena_${run.id.slice(0, 8)}_step${run.steps_executed}.md` }).click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="Отчёт о передаче смены" onClick={(e) => e.stopPropagation()}>
        <header><b>Отчёт о передаче смены</b><button className="icon-btn" onClick={onClose} aria-label="Закрыть">×</button></header>
        {error && <p className="error">{error}</p>}
        {!md && !error && <div className="skeleton tall" />}
        {md && <pre className="report">{md}</pre>}
        <footer>
          <button className="btn" disabled={!md} onClick={() => md && navigator.clipboard.writeText(md)}>Копировать</button>
          <button className="btn btn-primary" disabled={!md} onClick={download}>Скачать .md</button>
        </footer>
      </div>
    </div>
  );
}
