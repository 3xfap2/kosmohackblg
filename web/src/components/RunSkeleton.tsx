// Экран ожидания смены: орбиты-загрузчик и «скелет» страницы на месте показателей и карты.
// Сервер восстанавливает смену повтором журнала моделью — это занимает секунды.
export default function RunSkeleton({ title = "Восстанавливаем смену", note = "повторяем журнал моделью организаторов" }: {
  title?: string; note?: string;
}) {
  return (
    <div className="run-skeleton" aria-busy="true" aria-live="polite">
      <div className="loader">
        <div className="loader-orbits" aria-hidden>
          <span className="o1"><i /></span>
          <span className="o2"><i /></span>
          <span className="o3"><i /></span>
          <b />
        </div>
        <p className="loader-title">{title}<span className="dots"><i>.</i><i>.</i><i>.</i></span></p>
        <p className="muted small">{note}</p>
      </div>
      <div className="sk-kpis">{Array.from({ length: 6 }, (_, i) => <div key={i} className="sk" style={{ animationDelay: `${i * 80}ms` }} />)}</div>
      <div className="sk-layout">
        <div className="sk sk-main" />
        <div className="sk-side"><div className="sk" /><div className="sk" /></div>
      </div>
    </div>
  );
}
