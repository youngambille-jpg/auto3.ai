import { useMemo } from "react";
import type { BacktestResult } from "../backtest/engine.js";
import type { Strategy } from "../strategy/spec.js";

interface Props {
  result: BacktestResult;
  strategy: Strategy;
}

/**
 * A small inline SVG price chart with the strategy's overlays: grid levels,
 * trigger line, or TWAP slice markers. Hand-rolled to avoid a chart dependency.
 */
export function PriceChart({ result, strategy }: Props) {
  const { path, fills, band, trigger, w, h } = useMemo(() => {
    const pts = result.points;
    const w = 460;
    const h = 180;
    const pad = 8;
    const xs = pts.map((p) => p.t);
    const ys = pts.map((p) => p.price);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanY = maxY - minY || 1;
    const x = (t: number) => pad + ((t - minX) / (maxX - minX || 1)) * (w - 2 * pad);
    const y = (v: number) => pad + (1 - (v - minY) / spanY) * (h - 2 * pad);

    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
    const fills = result.fills.map((f) => ({ cx: x(f.t), cy: y(f.price) }));

    let band: { y1: number; y2: number } | null = null;
    let trigger: { y: number } | null = null;
    if (strategy.kind === "grid") {
      band = { y1: y(strategy.upperPrice), y2: y(strategy.lowerPrice) };
    } else if (strategy.kind === "limit") {
      trigger = { y: y(strategy.limitPrice) };
    } else if (strategy.kind === "stop") {
      trigger = { y: y(strategy.stopPrice) };
    }
    return { path: d, fills, band, trigger, w, h };
  }, [result, strategy]);

  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Backtest price chart">
      {band && (
        <rect
          x={0}
          y={Math.min(band.y1, band.y2)}
          width={w}
          height={Math.abs(band.y2 - band.y1)}
          className="band"
        />
      )}
      {trigger && <line x1={0} x2={w} y1={trigger.y} y2={trigger.y} className="trigger" />}
      <path d={path} className="price" />
      {fills.map((f, i) => (
        <circle key={i} cx={f.cx} cy={f.cy} r={3.5} className="fill" />
      ))}
    </svg>
  );
}
