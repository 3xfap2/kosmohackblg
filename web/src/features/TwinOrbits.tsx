import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { RunRecord, Timeline } from "../api/types";
import OrbitView from "../components/OrbitView";
import { fromTimeline } from "../lib/cells";
import { ALGO, GOAL, clock } from "../format";

// Две ветви рядом на одном времени: видно, где и как разошлись решения.
export default function TwinOrbits({ a, b, forkStep }: { a: RunRecord; b: RunRecord; forkStep: number | null }) {
  const [ta, setTa] = useState<Timeline | null>(null);
  const [tb, setTb] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [k, setK] = useState(forkStep ?? 0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    Promise.all([api.timeline(a), api.timeline(b)]).then(([x, y]) => { setTa(x); setTb(y); }).catch((e) => setError(e.message));
  }, [a, b]);
  const [ba, bb] = useMemo(() => [ta && fromTimeline(ta), tb && fromTimeline(tb)], [ta, tb]);
  const last = Math.max(Math.min(ba?.executed ?? 1, bb?.executed ?? 1) - 1, 0);

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => { if (k >= last) setPlaying(false); else setK(k + 1); }, 160);
    return () => clearTimeout(id);
  }, [playing, k, last]);

  // Сколько спутников на этом шаге делают разное — мера расхождения ветвей.
  const diff = useMemo(() => {
    if (!ta || !tb) return 0;
    let n = 0;
    ta.satellites.forEach((sid, i) => {
      const j = tb.satellites.indexOf(sid);
      if (j >= 0 && (ta.action[i][k] !== tb.action[j][k] || ta.job[i][k] !== tb.job[j][k])) n++;
    });
    return n;
  }, [ta, tb, k]);

  if (error) return <p className="error">{error}</p>;
  if (!ba || !bb) return <div className="skeleton tall" />;
  const label = (r: RunRecord) => `${GOAL[r.run_metadata.goal]} · ${ALGO[r.run_metadata.algorithm]}`;
  return (
    <section className="card">
      <div className="card-head">
        <h2>Две ветви рядом</h2>
        <span className="mono small">{clock(k)} · решения различаются у <b className={diff ? "warn-text" : ""}>{diff}</b> из {ta!.satellites.length} спутников</span>
      </div>
      <div className="twin">
        {[[a, ba, "A"], [b, bb, "B"]].map(([r, board, name]) => (
          <div key={name as string}>
            <p className="twin-label"><b>{name as string}</b> {label(r as RunRecord)}</p>
            <OrbitView compact board={board as ReturnType<typeof fromTimeline>} events={(r as RunRecord).events} step={k} onStep={setK} />
          </div>
        ))}
      </div>
      <div className="orbit-controls">
        <button className="btn btn-play" onClick={() => { if (k >= last) setK(forkStep ?? 0); setPlaying(!playing); }}>
          {playing ? "❚❚  Пауза" : "▶  Проиграть обе"}
        </button>
        <div className="timeline">
          <input type="range" min={0} max={last} value={Math.min(k, last)} onChange={(e) => { setPlaying(false); setK(+e.target.value); }}
            aria-label="Время" style={{ ["--p" as string]: `${(Math.min(k, last) / Math.max(last, 1)) * 100}%` }} />
          {forkStep != null && <span className="tick fork" style={{ left: `${(forkStep / Math.max(last, 1)) * 100}%` }} title={`развилка ${clock(forkStep)}`} />}
        </div>
      </div>
      {forkStep != null && <p className="muted tiny">До {clock(forkStep)} ветви совпадают — общее прошлое. Жёлтая метка — момент развилки.</p>}
    </section>
  );
}
