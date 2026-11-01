"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The answer's chart in Crime Index's Timeline style (no gridlines, #ccc y axis, a 1.5px line over a gradient area, the
 * dark tooltip), drawn at its real pixel width so labels stay 14px. "line" and "bar" plot a time series; "hbar" plots a
 * breakdown, one bar per category in the table's order (spec: breakdown charts). `hover` links it to the table.
 */
export type Point = { x: string; label: string; y: number | null };
type Props = { kind: "line" | "bar" | "hbar"; points: Point[]; series: string; sub: string; hover: number | null; onHover: (i: number | null) => void };

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });
function ticks(max: number): number[] {
  const steps = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
  const step = steps.find((s) => max / s <= 5) ?? 250000;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
  return out.length > 1 ? out : [0, step];
}

export default function AnswerChart({ kind, points, series, sub, hover, onHover }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const vals = points.map((p) => p.y).filter((v): v is number => v !== null);
  const max = vals.length ? Math.max(...vals) : 1;
  const tk = ticks(max || 1), yMax = tk[tk.length - 1];
  const n = points.length;

  let svg: React.ReactNode = null, H = 0, tipX = 0;
  if (W > 0 && kind === "hbar") {
    // A breakdown: categories down the side, values along the bottom.
    const L = Math.min(220, Math.max(90, W * 0.32)), R = 56, T = 8, rowH = 30, B = 28;
    H = T + n * rowH + B;
    const x = (v: number) => L + (v / yMax) * (W - L - R);
    svg = (
      <svg width={W} height={H} role="img" aria-label={series}>
        <g className="axis">
          <line x1={L} y1={T} x2={L} y2={H - B} />
          {tk.map((t) => <text key={t} x={x(t)} y={H - 8} textAnchor="middle">{fmt(t)}</text>)}
        </g>
        {points.map((p, i) => {
          const y = T + i * rowH;
          return (
            <g key={i} onMouseEnter={() => onHover(i)} onMouseLeave={() => onHover(null)}>
              <text className="lab" x={L - 10} y={y + rowH / 2 + 4} textAnchor="end">{p.label.length > 30 ? `${p.label.slice(0, 29)}...` : p.label}</text>
              {p.y !== null ? <rect className={`bar${hover !== null && hover !== i ? " dim" : ""}`} x={L} y={y + 5} width={Math.max(1, x(p.y) - L)} height={rowH - 10} rx={2} /> : null}
              <text className="lab" x={(p.y !== null ? x(p.y) : L) + 6} y={y + rowH / 2 + 4}>{p.y === null ? "" : fmt(p.y)}</text>
              <rect x={0} y={y} width={W} height={rowH} fill="transparent" />
            </g>
          );
        })}
      </svg>
    );
  } else if (W > 0) {
    const L = 65, R = 8, T = 24, B = 32;
    H = 380;
    const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
    const slot = (W - L - R) / n, bw = Math.min(slot / 1.5, 64);
    const x = kind === "bar" ? (i: number) => L + slot * (i + 0.5) : (i: number) => L + (n > 1 ? (i / (n - 1)) * (W - L - R) : (W - L - R) / 2);
    const at = (px: number) => Math.max(0, Math.min(n - 1, kind === "bar" ? Math.floor((px - L) / slot) : Math.round(((px - L) / (W - L - R)) * (n - 1))));
    // A line breaks at an unknown month: never drawn as zero.
    const segs: [number, number][][] = [];
    let cur: [number, number][] = [];
    points.forEach((p, i) => { if (p.y === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(p.y)]); });
    if (cur.length) segs.push(cur);
    // Year labels for months (on January), every label for years and quarters, thinned to fit.
    const monthly = /^\d{4}-\d{2}$/.test(points[0]?.x ?? "");
    const every = Math.ceil(n / Math.max(1, Math.floor((W - L - R) / 70)));
    // Within one year, the months are named (Jan, Apr, Jul, Oct); across years, each year is marked on its January.
    const oneYear = monthly && points.every((p) => p.x.slice(0, 4) === points[0].x.slice(0, 4));
    const xl = points.map((p, i) => (oneYear ? ((Number(p.x.slice(5)) - 1) % 3 === 0 ? i : -1) : monthly ? (p.x.endsWith("-01") ? i : -1) : i % every === 0 ? i : -1)).filter((i) => i >= 0);
    const xText = (i: number) => (oneYear ? ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(points[i].x.slice(5)) - 1] : monthly ? points[i].x.slice(0, 4) : points[i].label);
    if (hover !== null) tipX = x(hover);
    svg = (
      <svg width={W} height={H} role="img" aria-label={series}
        onMouseMove={(e) => onHover(at(e.clientX - e.currentTarget.getBoundingClientRect().left))} onMouseLeave={() => onHover(null)}>
        <defs><linearGradient id="cda-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9C7CCB" stopOpacity=".55" /><stop offset="1" stopColor="#6B3FA0" stopOpacity=".08" /></linearGradient></defs>
        <g className="axis">
          {tk.map((t) => <g key={t}><text x={L - 10} y={y(t) + 5} textAnchor="end">{fmt(t)}</text><line x1={L - 6} y1={y(t)} x2={L} y2={y(t)} /></g>)}
          <line x1={L} y1={T} x2={L} y2={H - B} />
          {xl.map((i) => <text key={i} x={x(i)} y={H - B + 22} textAnchor={monthly && !oneYear ? "start" : "middle"}>{xText(i)}</text>)}
        </g>
        {kind === "bar"
          ? points.map((p, i) => (p.y === null ? null : <rect key={i} className={`bar${hover !== null && hover !== i ? " dim" : ""}`} x={x(i) - bw / 2} y={y(p.y)} width={bw} height={y(0) - y(p.y)} rx={2} />))
          : <>
              {segs.map((s, k) => <path key={`a${k}`} className="area" d={`M${s[0][0]},${y(0)} L${s.map((q) => q.join(",")).join("L")} L${s[s.length - 1][0]},${y(0)} Z`} />)}
              <path className="series" d={segs.map((s) => `M${s.map((q) => q.join(",")).join("L")}`).join(" ")} />
              {hover !== null ? <line className="ptr" x1={x(hover)} y1={T} x2={x(hover)} y2={H - B} /> : null}
              {hover !== null && points[hover]?.y !== null ? <circle className="dot" r={5} cx={x(hover)} cy={y(points[hover].y as number)} /> : null}
            </>}
      </svg>
    );
  }

  const p = hover !== null ? points[hover] : null;
  return (
    <div className="Chart" ref={box}>
      {svg}
      {p && kind !== "hbar" ? (
        <div className="Tip" style={{ left: tipX + 304 > W ? tipX - 304 : tipX + 16, top: 24 }}>
          <div className="head"><div className="t">{p.label}</div><div className="s">{sub}</div></div>
          <div className="row"><span>{series}</span><span className="v">{p.y === null ? "No report" : fmt(p.y)}</span></div>
        </div>
      ) : null}
    </div>
  );
}
