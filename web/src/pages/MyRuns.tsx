import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, isStaleVersion, rebuildRun } from "../api/client";
import { store } from "../api/store";
import type { RunRecord } from "../api/types";
import { ALGO, GOAL, clock } from "../format";
import type { RunView } from "../api/types";

// Все смены из браузера: ветви под своими родителями, открыть / сравнить две / удалить.
export default function MyRuns() {
  const nav = useNavigate();
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [lengths, setLengths] = useState<Record<string, number>>({});
  useEffect(() => { store.all().then(setRuns); }, []);
  useEffect(() => { api.scenarios().then((list) => setLengths(Object.fromEntries(list.map((x) => [x.id, x.steps])))).catch(() => {}); }, []);
  // Длина смены — из сценария: встроенный — по справочнику сервера, свой — из самого JSON.
  const stepsOf = (r: RunRecord): number => "inline" in r.scenario
    ? ((r.scenario.inline as { time?: { steps?: number } }).time?.steps ?? 288)
    : lengths[r.scenario.ref] ?? 288;

  let demoId: string | null = null;
  try { demoId = localStorage.getItem("sz_demo_run_v2"); } catch { /* нет хранилища */ }
  const name = (r: RunRecord) => r.run_metadata.parent
    ? `Ветвь от ${clock(r.run_metadata.parent.fork_step)}`
    : r.id === demoId ? "Демо-смена" : `Смена ${"ref" in r.scenario ? r.scenario.ref : "своя"}`;

  // Порядок дерева: корень, затем его ветви по времени развилки (ветви без родителя в списке — как корни).
  const all = runs ?? [];
  const ids = new Set(all.map((r) => r.id));
  const kids = (id: string | null) => all
    .filter((r) => (r.run_metadata.parent && ids.has(r.run_metadata.parent.run_id) ? r.run_metadata.parent.run_id : null) === id)
    .sort((a, b) => (a.run_metadata.parent?.fork_step ?? 0) - (b.run_metadata.parent?.fork_step ?? 0));
  const tree: { r: RunRecord; depth: number }[] = [];
  const walk = (id: string | null, depth: number) => kids(id).forEach((r) => { tree.push({ r, depth }); walk(r.id, depth + 1); });
  walk(null, 0);

  const toggle = (id: string) => setPicked((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]);
  const remove = async (r: RunRecord) => {
    const children = all.filter((x) => x.run_metadata.parent?.run_id === r.id).length;
    if (!confirm(`Удалить «${name(r)}»?${children ? ` Её ветви (${children}) останутся в списке.` : ""}`)) return;
    await store.remove(r.id);
    setPicked((p) => p.filter((x) => x !== r.id));
    setRuns(await store.all());
  };

  // Смена из файла: подпись и версию проверяет сервер; запись другой версии пересчитывается.
  const [loading, setLoading] = useState<string | null>(null);
  const importRun = async (file: File) => {
    setLoading("Проверяем файл смены…");
    try {
      const record = JSON.parse(await file.text()) as RunRecord;
      if (record?.schema !== "sozvezdie-run-1") throw new Error("Это не файл смены: нужен JSON с полем schema = sozvezdie-run-1");
      let saved = record;
      try { (await api.view(record)) as RunView; } catch (e) {
        if (!isStaleVersion(e)) throw e;
        // Подпись чужого файла могла быть нарушена правкой: пересчитываем только с согласия оператора
        // и предупреждаем, что итог будет посчитан заново из сценария и сообщений файла.
        if (/Подпись записи/.test(String((e as Error).message))
            && !window.confirm("Подпись файла не совпадает: он изменён вне сервиса или подписан другим сервером. "
              + "Продолжить? Смена будет рассчитана заново из сценария и сообщений файла, сохранённые в нём итоги приняты не будут.")) {
          setLoading(null);
          return;
        }
        setLoading("Пересчитываем смену из файла…");
        saved = (await rebuildRun(record)).run;
      }
      await store.save(saved);
      setRuns(await store.all());
      nav(`/console/run/${saved.id}`);
    } catch (e) { setLoading(null); alert(`Файл не принят: ${(e as Error).message}`); }
  };

  return (
    <div className="setup">
      <div className="page-head">
        <div>
          <h1>Мои смены</h1>
          <p className="muted small">Смены хранятся только в этом браузере, без регистрации. Чтобы открыть смену на другом
            компьютере, скачайте файл смены на её странице и загрузите здесь.{loading ? ` ${loading}` : ""}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" disabled={picked.length !== 2}
            onClick={() => nav(`/console/compare?a=${picked[0]}&b=${picked[1]}`)}>
            Сравнить выбранные{picked.length ? ` (${picked.length}/2)` : ""}
          </button>
          <label className="btn file">Загрузить смену из файла
            <input type="file" accept=".json,application/json" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importRun(f); e.target.value = ""; }} />
          </label>
          <Link className="btn" to="/console/new">Новая смена</Link>
        </div>
      </div>

      <section className="card">
        {!runs && <div className="skeleton" />}
        {runs && !runs.length && (
          <div className="empty">
            <p>Пока нет ни одной смены.</p>
            <p className="muted small">Откройте демо-смену или настройте свою — она появится здесь.</p>
            <div className="page-actions"><Link className="btn btn-primary" to="/console">Открыть демо-смену</Link></div>
          </div>
        )}
        {runs && runs.length > 0 && (
          <table className="table runs-table">
            <thead><tr><th /><th>Смена</th><th>Цель</th><th>Алгоритм</th><th>Рассчитано</th><th>Сообщения</th><th /></tr></thead>
            <tbody>
              {tree.map(({ r, depth }) => (
                <tr key={r.id} className={picked.includes(r.id) ? "picked" : ""} onClick={() => nav(`/console/run/${r.id}`)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Выбрать для сравнения" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  <td style={{ paddingLeft: 8 + depth * 18 }}>
                    {depth > 0 && <span className="muted">└ </span>}<b>{name(r)}</b>
                    <div className="muted tiny mono">{"ref" in r.scenario ? r.scenario.ref : "свой сценарий"} · {r.id.slice(0, 8)}</div>
                  </td>
                  <td>{GOAL[r.run_metadata.goal]}</td>
                  <td className="muted">{ALGO[r.run_metadata.algorithm]}</td>
                  <td className="mono">
                    <div className="mini-bar"><i style={{ width: `${(r.steps_executed / stepsOf(r)) * 100}%` }} /></div>
                    {r.steps_executed >= stepsOf(r) ? "смена завершена" : `до ${clock(r.steps_executed)} из ${clock(stepsOf(r))}`}
                  </td>
                  <td className="mono">{r.events.length}{r.rejected_events.length ? <span className="muted"> · отклонено {r.rejected_events.length}</span> : null}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-sm" onClick={() => remove(r)} aria-label="Удалить смену">Удалить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
