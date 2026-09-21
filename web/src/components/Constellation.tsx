import { useEffect, useRef } from "react";

// 48 точек-аппаратов на трёх наклонных орбитах. Чистая декорация героя лендинга;
// при prefers-reduced-motion рисуется один статичный кадр.
export default function Constellation({ count = 48 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sats = Array.from({ length: count }, (_, i) => ({
      orbit: i % 3, phase: (i / count) * Math.PI * 2 * 3, speed: 0.00012 + (i % 3) * 0.00004,
    }));
    let raf = 0;
    const draw = (t: number) => {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.42;
      for (let o = 0; o < 3; o++) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.5 + o * 0.5);
        ctx.strokeStyle = "#292d30"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.34, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      for (const s of sats) {
        const a = s.phase + t * s.speed;
        const rot = -0.5 + s.orbit * 0.5;
        const x0 = Math.cos(a) * r, y0 = Math.sin(a) * r * 0.34;
        const x = cx + x0 * Math.cos(rot) - y0 * Math.sin(rot);
        const y = cy + x0 * Math.sin(rot) + y0 * Math.cos(rot);
        const front = Math.sin(a) > 0;
        ctx.fillStyle = front ? "#f0f0f0" : "#6e727a";
        ctx.beginPath(); ctx.arc(x, y, front ? 2.2 : 1.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#0b0e14"; ctx.strokeStyle = "#292d30";
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.22, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [count]);

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} aria-hidden />;
}
