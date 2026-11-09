import { useEffect, useRef, useState } from "react";

/**
 * 控制台用的几种小图。全部手画 SVG、颜色走主题变量，所以黑紫 / 白紫自动跟着变，
 * 也不必为几张小图引一个图表库。
 *
 * 画线动画用 pathLength="1"：不用量路径多长，CSS 里把虚线长度当 1 来动就行。
 */

const reduced = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 数字从 0 滚到目标值（约 0.8 秒，先快后慢）。目标值变了就从当前值滚过去。 */
export function CountUp({ value }: { value: number }): React.JSX.Element {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  const still = reduced() || typeof requestAnimationFrame !== "function";
  useEffect(() => {
    if (still) return;
    const start = from.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0) / 800);
      const v = Math.round(start + (value - start) * (1 - Math.pow(1 - k, 3)));
      setShown(v);
      from.current = v;
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, still]);
  return <>{(still ? value : shown).toLocaleString("zh-CN")}</>;
}

const linePath = (pts: readonly (readonly [number, number])[]): string =>
  pts
    .map(
      (p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`,
    )
    .join(" ");

/** 迷你趋势线：面积 + 线 + 末端圆点。 */
export function Sparkline({
  data,
  label,
}: {
  data: readonly number[];
  label: string;
}): React.JSX.Element {
  const w = 96;
  const h = 34;
  const max = Math.max(1, ...data);
  const pts = data.map(
    (v, i) =>
      [
        (i / Math.max(1, data.length - 1)) * w,
        h - 2 - (v / max) * (h - 6),
      ] as const,
  );
  const last = pts.at(-1) ?? ([w, h] as const);
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      role="img"
      aria-label={label}
    >
      <path
        className="area"
        d={`${linePath(pts)} L${String(w)} ${String(h)} L0 ${String(h)} Z`}
      />
      <path className="line draw" d={linePath(pts)} pathLength={1} />
      <circle className="end" cx={last[0]} cy={last[1]} r={3} />
    </svg>
  );
}

/** 小柱图：最后一根用强调色，其余用浅色。 */
export function MiniBars({
  data,
  label,
}: {
  data: readonly number[];
  label: string;
}): React.JSX.Element {
  const w = 96;
  const h = 34;
  const gap = 4;
  const bw = (w - gap * (data.length - 1)) / Math.max(1, data.length);
  const max = Math.max(1, ...data);
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      role="img"
      aria-label={label}
    >
      {data.map((v, i) => {
        const bh = Math.max(2, (v / max) * h);
        return (
          <rect
            key={i}
            className={`bar grow-y${i === data.length - 1 ? " on" : ""}`}
            style={{ animationDelay: `${String(i * 40)}ms` }}
            x={i * (bw + gap)}
            y={h - bh}
            width={bw}
            height={bh}
            rx={2}
          />
        );
      })}
    </svg>
  );
}

/** 进度环。 */
export function Ring({
  value,
  total,
  label,
  size = 40,
}: {
  value: number;
  total: number;
  label: string;
  size?: number;
}): React.JSX.Element {
  const pct = total === 0 ? 0 : Math.min(100, (value / total) * 100);
  const r = size / 2 - 4;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      role="img"
      aria-label={label}
    >
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} />
      <circle
        className="ring-value ring-draw"
        cx={size / 2}
        cy={size / 2}
        r={r}
        pathLength={100}
        strokeDasharray={`${String(pct)} 100`}
        transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
      />
    </svg>
  );
}

/** 方块阵：每块一个待办，警示的排在前面。 */
export function DotGrid({
  total,
  warn,
  label,
}: {
  total: number;
  warn: number;
  label: string;
}): React.JSX.Element {
  const n = Math.min(total, 15);
  return (
    <svg
      width={62}
      height={34}
      viewBox="0 0 62 34"
      role="img"
      aria-label={label}
    >
      {Array.from({ length: n }, (_, i) => (
        <rect
          key={i}
          className={`dot-cell${i < warn ? " warn" : ""}`}
          style={{ animationDelay: `${String(i * 30)}ms` }}
          x={(i % 5) * 13}
          y={Math.floor(i / 5) * 12 + (n <= 5 ? 12 : n <= 10 ? 6 : 0)}
          width={10}
          height={10}
          rx={2.5}
        />
      ))}
      {n === 0 && (
        <rect
          className="dot-cell empty"
          x={0}
          y={12}
          width={10}
          height={10}
          rx={2.5}
        />
      )}
    </svg>
  );
}

/**
 * 双序列折线面积图：横轴是日期，纵轴自动取一个整齐的上限（4 的倍数），
 * 刻度与数据用同一个比例尺。
 */
export function TrendChart({
  days,
  series,
  label,
}: {
  days: readonly string[];
  series: readonly { name: string; data: readonly number[]; tone: "a" | "b" }[];
  label: string;
}): React.JSX.Element {
  // 宽高比约 4:1：卡片占三分之二宽时，图高在 200px 上下，不显得空。
  const W = 860;
  const H = 200;
  const L = 30;
  const R = 852;
  const T = 12;
  const B = 172;
  const peak = Math.max(1, ...series.flatMap((s) => s.data));
  const ymax = Math.max(4, Math.ceil(peak / 4) * 4);
  const n = days.length;
  const x = (i: number): number => L + (i / Math.max(1, n - 1)) * (R - L);
  const y = (v: number): number => B - (v / ymax) * (B - T);
  const ticks = [0, ymax / 4, ymax / 2, (ymax * 3) / 4, ymax];
  const xLabels =
    n > 0
      ? [0, Math.floor((n - 1) / 3), Math.floor(((n - 1) * 2) / 3), n - 1]
      : [];
  return (
    <svg
      className="trend"
      viewBox={`0 0 ${String(W)} ${String(H)}`}
      role="img"
      aria-label={label}
    >
      <g className="axis">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={R} y1={y(v)} y2={y(v)} />
            <text x={L - 8} y={y(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {[...new Set(xLabels)].map((i) => (
          <text
            key={i}
            x={x(i)}
            y={B + 20}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
          >
            {days[i]}
          </text>
        ))}
      </g>
      {series.map((s) => {
        const pts = s.data.map((v, i) => [x(i), y(v)] as const);
        return (
          <g key={s.name} className={`series tone-${s.tone}`}>
            {s.tone === "a" && (
              <path
                className="area"
                d={`${linePath(pts)} L${String(R)} ${String(B)} L${String(L)} ${String(B)} Z`}
              />
            )}
            <path className="line draw" d={linePath(pts)} pathLength={1} />
            {pts.length > 0 && (
              <circle
                className="end"
                cx={pts[pts.length - 1]?.[0]}
                cy={pts[pts.length - 1]?.[1]}
                r={4}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** 环形图：各段之间留 1 个单位的缝；中间写总数。 */
export function Donut({
  parts,
  unit,
  label,
}: {
  parts: readonly { name: string; value: number; tone: string }[];
  unit: string;
  label: string;
}): React.JSX.Element {
  const total = parts.reduce((s, p) => s + p.value, 0);
  let offset = 0;
  return (
    <svg className="donut" viewBox="0 0 120 120" role="img" aria-label={label}>
      <circle className="ring-track" cx={60} cy={60} r={46} />
      {total > 0 &&
        parts.map((p, i) => {
          const len = (p.value / total) * 100;
          const seg = (
            <circle
              key={p.name}
              className={`donut-seg tone-${p.tone} ring-draw`}
              style={{ animationDelay: `${String(i * 90)}ms` }}
              cx={60}
              cy={60}
              r={46}
              pathLength={100}
              strokeDasharray={`${String(Math.max(0, len - (parts.filter((x) => x.value > 0).length > 1 ? 1 : 0)))} 100`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            />
          );
          offset += len;
          return p.value > 0 ? seg : null;
        })}
      <text className="donut-total" x={60} y={62} textAnchor="middle">
        {total}
      </text>
      <text className="donut-unit" x={60} y={78} textAnchor="middle">
        {unit}
      </text>
    </svg>
  );
}
