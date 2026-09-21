import { useEffect, useRef } from "react";

// Иллюстрация героя лендинга в стиле консоли: Земля, Солнце слева, тень справа, спутники меняют
// занятие (ретрансляция, передача на Землю с лучом к станции, ожидание). Состояния — декоративные.
const COL = { relay: "#b4a4ff", downlink: "#6cb6ff", idle: "#8b9097", calibrate: "#f5c451" } as const;
type Kind = keyof typeof COL;

export default function Constellation({ count = 36 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const g = canvas.getContext("2d")!;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const rings = [1.5, 1.8, 2.1, 2.4].map((r, i) => ({ r, tilt: [-0.25, 0.15, -0.05, 0.28][i], squash: [0.34, 0.3, 0.4, 0.3][i] }));
    const sats = Array.from({ length: count }, (_, i) => ({
      ring: i % rings.length, phase: rnd() * Math.PI * 2, speed: 0.00016 + (i % 4) * 0.00003, shift: rnd() * 9000,
    }));
    const stars = Array.from({ length: 120 }, () => ({ x: rnd(), y: rnd(), r: rnd() * 1 + 0.2, a: rnd() * 0.5 + 0.1 }));
    const kindOf = (i: number, t: number): Kind => {
      const v = Math.floor((t + sats[i].shift) / 2600 + i * 1.7) % 7;
      return v < 2 ? "relay" : v === 2 ? "downlink" : v === 3 ? "calibrate" : "idle";
    };
    let raf = 0;
    const draw = (t: number) => {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr; canvas.height = h * dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const cx = w / 2 + w * 0.04, cy = h / 2, R = Math.min(w, h) * 0.17;
      for (const s of stars) { g.globalAlpha = s.a; g.fillStyle = "#dfe6ff"; g.beginPath(); g.arc(s.x * w, s.y * h, s.r, 0, 7); g.fill(); }
      g.globalAlpha = 1;
      const sun = g.createRadialGradient(0, cy, 0, 0, cy, w * 0.28);
      sun.addColorStop(0, "rgba(255,200,110,0.35)"); sun.addColorStop(1, "rgba(255,200,110,0)");
      g.fillStyle = sun; g.fillRect(0, 0, w, h);
      const shade = g.createLinearGradient(cx, 0, cx + R * 3.2, 0);
      shade.addColorStop(0, "rgba(4,6,10,0.9)"); shade.addColorStop(1, "rgba(4,6,10,0)");
      g.fillStyle = shade; g.fillRect(cx, cy - R, R * 3.2, R * 2);
      for (const ring of rings) {
        g.save(); g.translate(cx, cy); g.rotate(ring.tilt); g.strokeStyle = "rgba(255,255,255,0.07)";
        g.beginPath(); g.ellipse(0, 0, R * ring.r, R * ring.r * ring.squash, 0, 0, Math.PI * 2); g.stroke(); g.restore();
      }
      const pts = sats.map((s, i) => {
        const ring = rings[s.ring], a = s.phase + (still ? 0 : t) * s.speed;
        const x0 = Math.cos(a) * R * ring.r, y0 = Math.sin(a) * R * ring.r * ring.squash;
        return { i, front: Math.sin(a) > 0, x: cx + x0 * Math.cos(ring.tilt) - y0 * Math.sin(ring.tilt),
          y: cy + x0 * Math.sin(ring.tilt) + y0 * Math.cos(ring.tilt), dark: Math.cos(a) > 0.55 };
      });
      const station = { x: cx - R * 0.72, y: cy - R * 0.7 };
      const drawSat = (p: (typeof pts)[number]) => {
        const k = kindOf(p.i, still ? 0 : t);
        if (k === "downlink") {
          g.strokeStyle = "rgba(108,182,255,0.55)"; g.setLineDash([4, 3]); g.lineDashOffset = -t / 60;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(station.x, station.y); g.stroke(); g.setLineDash([]);
        }
        if (k !== "idle") {
          const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, 10);
          halo.addColorStop(0, COL[k] + "66"); halo.addColorStop(1, COL[k] + "00");
          g.fillStyle = halo; g.beginPath(); g.arc(p.x, p.y, 10, 0, 7); g.fill();
        }
        g.globalAlpha = p.dark && k === "idle" ? 0.35 : 1;
        g.fillStyle = COL[k]; g.beginPath(); g.arc(p.x, p.y, k === "idle" ? 2.2 : 3.2, 0, 7); g.fill(); g.globalAlpha = 1;
      };
      pts.filter((p) => !p.front).forEach(drawSat);
      const glow = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.3);
      glow.addColorStop(0, "rgba(108,182,255,0.2)"); glow.addColorStop(1, "rgba(108,182,255,0)");
      g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, R * 1.3, 0, 7); g.fill();
      const earth = g.createRadialGradient(cx - R * 0.45, cy - R * 0.35, R * 0.08, cx, cy, R);
      earth.addColorStop(0, "#3b6aa8"); earth.addColorStop(0.45, "#173356"); earth.addColorStop(0.8, "#0a1526"); earth.addColorStop(1, "#04070c");
      g.fillStyle = earth; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
      g.fillStyle = "#6cb6ff"; g.beginPath(); g.moveTo(station.x, station.y - 5); g.lineTo(station.x - 4, station.y + 3); g.lineTo(station.x + 4, station.y + 3); g.fill();
      pts.filter((p) => p.front).forEach(drawSat);
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [count]);

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} aria-hidden />;
}
