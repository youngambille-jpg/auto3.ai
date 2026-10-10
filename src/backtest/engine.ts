/**
 * Strategy backtest. Pure functions over a candle series so the same code runs
 * in the browser preview and in tests. This is what makes the preview honest:
 * it replays the strategy against recent prices and reports what it would have
 * done, including the cases where it would have done nothing.
 */

import type { Strategy } from "../strategy/spec.js";
import { isStable } from "../strategy/prices.js";

export interface Candle {
  /** epoch ms */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface EquityPoint {
  t: number;
  price: number;
  equity: number;
}

export interface BacktestFill {
  t: number;
  price: number;
  sizedBase: number;
  note: string;
}

export interface BacktestResult {
  points: EquityPoint[];
  fills: BacktestFill[];
  summary: {
    startPrice: number;
    endPrice: number;
    priceChangePct: number;
    /** Average execution price the strategy would have achieved. */
    avgFillPrice: number | null;
    /** Buy-and-hold result for the same size, as a baseline. */
    holdAvgPrice: number;
    /** Positive means the strategy beat holding, in USD per base unit. */
    edgeVsHold: number | null;
    filledFraction: number;
    numberOfFills: number;
    note: string;
  };
}

/** The USD price of the traded asset, whichever leg is the risky asset. */
function riskyIsBuy(s: Strategy): boolean {
  return isStable(s.sellSymbol);
}

function assetPriceFromCandle(s: Strategy, c: Candle): number {
  return riskyIsBuy(s) ? c.close : c.close;
}

function simulateTwap(s: Extract<Strategy, { kind: "twap" | "dca" }>, candles: Candle[]): BacktestResult {
  const spanMs = (candles.at(-1)!.t - candles[0]!.t) || 1;
  const windowMs = s.slices * s.intervalMinutes * 60_000;
  const startMs = candles[0]!.t;
  const perSlice = s.totalSize / s.slices;
  const fills: BacktestFill[] = [];

  for (let i = 0; i < s.slices; i++) {
    const targetT = startMs + i * s.intervalMinutes * 60_000;
    const c = nearestCandle(candles, targetT);
    if (!c) continue;
    fills.push({ t: c.t, price: assetPriceFromCandle(s, c), sizedBase: perSlice, note: `slice ${i + 1}` });
  }

  const covered = Math.min(1, windowMs / spanMs);
  return buildResult(s, candles, fills, `Replayed ${fills.length}/${s.slices} slices over ${Math.round(spanMs / 3_600_000)}h of history (${Math.round(covered * 100)}% of the requested window fit).`);
}

function simulateGrid(s: Extract<Strategy, { kind: "grid" }>, candles: Candle[]): BacktestResult {
  const step = (s.upperPrice - s.lowerPrice) / s.levels;
  const quotePerLevel = s.totalSize / s.levels;
  const buyIsRisky = isStable(s.sellSymbol);
  const fills: BacktestFill[] = [];
  const filledLevels = new Set<number>();

  // Walk forward; each time price crosses down through a level, buy it once.
  let prevClose = candles[0]!.close;
  for (const c of candles) {
    for (let lvl = 0; lvl < s.levels; lvl++) {
      const levelPrice = s.upperPrice - step * lvl;
      const crossedDown = prevClose > levelPrice && c.close <= levelPrice;
      if (crossedDown && !filledLevels.has(lvl)) {
        // Buying the base with quote means each level acquires quote/price base units.
        const sizedBase = buyIsRisky ? quotePerLevel / levelPrice : quotePerLevel;
        fills.push({ t: c.t, price: levelPrice, sizedBase, note: `level ${lvl + 1} @ ${levelPrice.toFixed(2)}` });
        filledLevels.add(lvl);
      }
    }
    prevClose = c.close;
  }

  return buildResult(
    s,
    candles,
    fills,
    `Grid levels crossed down and filled ${fills.length}/${s.levels} in the sample window.`,
  );
}

function simulateTrigger(
  s: Extract<Strategy, { kind: "limit" | "stop" }>,
  candles: Candle[],
): BacktestResult {
  const target = s.kind === "limit" ? s.limitPrice : s.stopPrice;
  const fills: BacktestFill[] = [];
  const hit = candles.find((c) => c.low <= target && c.high >= target);
  if (hit) {
    fills.push({ t: hit.t, price: target, sizedBase: s.totalSize, note: `triggered at ${target}` });
  }
  return buildResult(
    s,
    candles,
    fills,
    hit
      ? `Price traded through ${target} in the sample window: the order would have fired.`
      : `Price never reached ${target} in the sample window: the order would not have fired yet.`,
  );
}

export function backtest(s: Strategy, candles: Candle[]): BacktestResult {
  if (candles.length < 2) throw new Error("Need at least two candles to backtest.");
  switch (s.kind) {
    case "twap":
    case "dca":
      return simulateTwap(s, candles);
    case "grid":
      return simulateGrid(s, candles);
    case "limit":
    case "stop":
      return simulateTrigger(s, candles);
  }
}

function nearestCandle(candles: Candle[], t: number): Candle | undefined {
  if (t <= candles[0]!.t) return candles[0];
  if (t >= candles.at(-1)!.t) return candles.at(-1);
  for (const c of candles) if (c.t >= t) return c;
  return candles.at(-1);
}

/** Equity in USD terms, treating stablecoin leg as cash. */
function buildResult(
  s: Strategy,
  candles: Candle[],
  fills: BacktestFill[],
  note: string,
): BacktestResult {
  const start = candles[0]!.close;
  const end = candles.at(-1)!.close;
  const totalBase = s.totalSize;
  const filledBase = fills.reduce((a, f) => a + f.sizedBase, 0);
  const notional = fills.reduce((a, f) => a + f.sizedBase * f.price, 0);
  const avgFill = filledBase > 0 ? notional / filledBase : null;

  const holdsBase = riskyIsBuy(s) ? totalBase : 0;
  const holdCash = riskyIsBuy(s) ? 0 : totalBase;

  const points: EquityPoint[] = candles.map((c, i) => {
    const t = c.t;
    const done = fills.filter((f) => f.t <= t);
    const baseHeld = done.reduce((a, f) => a + f.sizedBase, 0) + (i === candles.length - 1 ? holdsBase : 0);
    const cash = totalBase - done.reduce((a, f) => a + f.sizedBase * f.price, 0) + (i === candles.length - 1 ? holdCash : 0);
    return {
      t,
      price: c.close,
      equity: cash + baseHeld * c.close,
    };
  });

  const holdEnd = holdCash + holdsBase * end;
  const stratEnd = points.at(-1)!.equity;
  const edgeVsHold = fills.length > 0 ? stratEnd - holdEnd : null;

  return {
    points,
    fills,
    summary: {
      startPrice: start,
      endPrice: end,
      priceChangePct: ((end - start) / start) * 100,
      avgFillPrice: avgFill,
      holdAvgPrice: start,
      edgeVsHold,
      filledFraction: totalBase > 0 ? filledBase / totalBase : 0,
      numberOfFills: fills.length,
      note,
    },
  };
}
