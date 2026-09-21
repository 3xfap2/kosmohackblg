import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { store } from "../api/store";
import RunSkeleton from "../components/RunSkeleton";

// Первое, что видит человек в консоли: готовая смена P02 с сообщениями организаторов.
// Демо — обычный живой запуск: в нём работают ветви, сравнение, сообщения и чат.
const KEY = "sz_demo_run_v2";   // v2: демо останавливается в 12:00
let pending: ReturnType<typeof api.demo> | null = null;   // один расчёт демо, даже при двойном эффекте

export default function DemoBoot({ fresh = false }: { fresh?: boolean }) {
  const nav = useNavigate();
  const search = useLocation().search;   // п.10: t и sat из ссылки на момент
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let id: string | null = null;
      try { id = fresh ? null : localStorage.getItem(KEY); } catch { /* хранилище недоступно */ }
      if (id && (await store.all()).some((r) => r.id === id)) { nav(`/console/run/${id}${search}`, { replace: true }); return; }
      try {
        pending ??= api.demo();
        const res = await pending;
        pending = null;
        await store.save(res.run);
        try { localStorage.setItem(`sz_suggest_${res.run.id}`, JSON.stringify(res.suggested_events ?? [])); } catch { /* без подсказок */ }
        try { localStorage.setItem(KEY, res.run.id); } catch { /* только на эту сессию */ }
        if (alive) nav(`/console/run/${res.run.id}${search}`, { replace: true });
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    return () => { alive = false; };
  }, [fresh, nav, search]);

  return (
    <div>
      {error ? <p className="error">Не удалось подготовить демо: {error}</p> : (
        <RunSkeleton title="Готовим демо-смену" note="P02 · 48 аппаратов · сутки · сообщения организаторов" />
      )}
    </div>
  );
}
