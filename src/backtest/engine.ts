/**
 * Strategy backtest. Pure functions over a candle series so the same code runs
 * in the browser preview and in tests. This is what makes the preview honest:
 * it replays the strategy against recent prices and reports what it would have
 * done, including the cases where it would have done nothing.
 *
 * Every fill is a signed flow in two legs: `base` (the risky asset whose USD
 * price the chart shows) and `cash` (the stable leg). Buying base spends cash;
 * selling base receives it. The same ledger then produces the equity path and a
 * buy-and-hold baseline for every strategy kind, whether the size was stated in
 * the asset or in cash.
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
  /** Base (risky) units acquired; negative when the fill sells base. */
  sizedBase: number;
  /** Signed cash flow: negative = spends cash, positive = receives cash. */
  cashDelta: number;
  note: string;
}

export interface BacktestResult {
  points: EquityPoint[];
  fills: BacktestFill[];
  summary: {
    startPrice: number;
    endPrice: number;
    priceChangePct: number;
    /** Average price the fills achieved, in cash per base. */
    avgFillPrice: number | null;
    /** Buy-and-hold entry price for the same capital, i.e. the start price. */
    holdAvgPrice: number;
    /** Positive means the strategy beat holding, in cash units at the end. */
    edgeVsHold: number | null;
    /** Fraction of the intended size that actually filled. */
    filledFraction: number;
    numberOfFills: number;
    note: string;
  };
}

/** True when the strategy spends the stable leg to acquire the risky leg. */
function buysBase(s: Strategy): boolean {
  return isStable(s.sellSymbol);
}

/**
 * True when `totalSize` counts units of the risky base asset rather than cash.
 * `sizeUnit` names the sell or buy leg and that leg is the base only when it is
 * the non-stable one, so this is not simply `sizeUnit === "buy"`: a stop-loss
 * that sells 1 ETH has `sizeUnit: "sell"` and a base-sized amount.
 */
function amountInBase(s: Strategy): boolean {
  const leg = s.sizeUnit === "buy" ? s.buySymbol : s.sellSymbol;
  return !isStable(leg);
}

/**
 * One order at a price, from the amount the user stated and which leg it counts.
 *   buy + inBase : acquire `amount` base, spending amount*price cash
 *   buy + inCash : spend `amount` cash, acquiring amount/price base
 *   sell + inBase: dispose `amount` base, receiving amount*price cash
 *   sell + inCash: receive `amount` cash, disposing amount/price base
 */
function resolveFlow(amount: number, price: number, inBase: boolean, buy: boolean) {
  const base = inBase ? amount : amount / price;
  return buy
    ? { base, cash: -base * price }
    : { base: -base, cash: base * price };
}

function makeFill(
  t: number,
  price: number,
  amount: number,
  inBase: boolean,
  buy: boolean,
  note: string,
): BacktestFill {
  const f = resolveFlow(amount, price, inBase, buy);
  return { t, price, sizedBase: f.base, cashDelta: f.cash, note };
}

function simulateTwap(
  s: Extract<Strategy, { kind: "twap" | "dca" }>,
  candles: Candle[],
): BacktestResult {
  const spanMs = (candles.at(-1)!.t - candles[0]!.t) || 1;
  const windowMs = s.slices * s.intervalMinutes * 60_000;
  const startMs = candles[0]!.t;
  const perSlice = s.totalSize / s.slices;
  const inBase = amountInBase(s);
  const buy = buysBase(s);
  const fills: BacktestFill[] = [];

  for (let i = 0; i < s.slices; i++) {
    const targetT = startMs + i * s.intervalMinutes * 60_000;
    const c = nearestCandle(candles, targetT);
    if (!c) continue;
    fills.push(makeFill(c.t, c.close, perSlice, inBase, buy, `slice ${i + 1}`));
  }

  const covered = Math.min(1, windowMs / spanMs);
  return buildResult(
    s,
    candles,
    fills,
    `Replayed ${fills.length}/${s.slices} slices over ${Math.round(spanMs / 3_600_000)}h of history (${Math.round(covered * 100)}% of the requested window fit).`,
  );
}

function simulateGrid(
  s: Extract<Strategy, { kind: "grid" }>,
  candles: Candle[],
): BacktestResult {
  const step = (s.upperPrice - s.lowerPrice) / s.levels;
  // `totalSize` is the capital allocated across the grid, in the leg it was
  // denominated in. Spread it evenly over the levels.
  const perLevel = s.totalSize / s.levels;
  const inBase = amountInBase(s);
  const buy = buysBase(s);
  const fills: BacktestFill[] = [];
  const filledLevels = new Set<number>();

  // Walk forward; each time price crosses down through a level, buy it once.
  let prevClose = candles[0]!.close;
  for (const c of candles) {
    for (let lvl = 0; lvl < s.levels; lvl++) {
      const levelPrice = s.upperPrice - step * lvl;
      const crossedDown = prevClose > levelPrice && c.close <= levelPrice;
      if (crossedDown && !filledLevels.has(lvl)) {
        fills.push(makeFill(c.t, levelPrice, perLevel, inBase, buy, `level ${lvl + 1} @ ${levelPrice.toFixed(2)}`));
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

/**
 * A trigger only fires when price approaches from the correct side. A buy-limit
 * rests below the market and fills on a downward cross; a stop-loss also fires
 * downward, but the user is selling. Selling into strength (sell-limit) and a
 * stop-buy both need an upward cross.
 */
function triggerDirection(s: Extract<Strategy, { kind: "limit" | "stop" }>): "down" | "up" {
  if (s.kind === "limit") return s.side === "buy" ? "down" : "up";
  return s.side === "sell" ? "down" : "up";
}

function simulateTrigger(
  s: Extract<Strategy, { kind: "limit" | "stop" }>,
  candles: Candle[],
): BacktestResult {
  const target = s.kind === "limit" ? s.limitPrice : s.stopPrice;
  const inBase = amountInBase(s);
  const buy = s.side === "buy";
  const direction = triggerDirection(s);
  const fills: BacktestFill[] = [];

  let hit: Candle | undefined;
  let prevClose = candles[0]!.close;
  for (const c of candles) {
    const approachedDown = prevClose > target && c.low <= target;
    const approachedUp = prevClose < target && c.high >= target;
    if ((direction === "down" && approachedDown) || (direction === "up" && approachedUp)) {
      hit = c;
      break;
    }
    prevClose = c.close;
  }

  if (hit) fills.push(makeFill(hit.t, target, s.totalSize, inBase, buy, `triggered at ${target}`));

  return buildResult(
    s,
    candles,
    fills,
    hit
      ? `Price crossed ${target} from the ${direction} side in the sample window: the order would have fired.`
      : `Price never crossed ${target} from the ${direction} side in the sample window: the order would not have fired yet.`,
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

/**
 * Equity path and the buy-and-hold baseline.
 *
 * The request implies a starting position, and the fills move value from there:
 *   - a buy campaign ("buy 2 ETH", "spend 100 USDC") starts with cash and
 *     acquires base;
 *   - a sell campaign ("sell 1 ETH", a stop-loss) starts holding base and turns
 *     it into cash.
 *
 * Equity marks the position at the current close:
 *   equity = (initialBase + acquired) * close + initialCash + sum(cashDelta)
 *
 * which is exactly the value of liquidating at the close, so it is honest by
 * construction. The hold baseline is the same starting position left untouched:
 * cash spent on base at the start for a buy, base simply retained for a sell.
 */
function buildResult(
  s: Strategy,
  candles: Candle[],
  fills: BacktestFill[],
  note: string,
): BacktestResult {
  const start = candles[0]!.close;
  const end = candles.at(-1)!.close;
  const inBase = amountInBase(s);
  const buy = buysBase(s);

  let initialBase: number;
  let initialCash: number;
  if (buy) {
    initialBase = 0;
    initialCash = inBase ? s.totalSize * start : s.totalSize;
  } else {
    initialBase = inBase ? s.totalSize : s.totalSize / start;
    initialCash = 0;
  }

  const equityAt = (close: number, done: BacktestFill[]) => {
    const acquired = done.reduce((a, f) => a + f.sizedBase, 0);
    const cashFlow = done.reduce((a, f) => a + f.cashDelta, 0);
    return (initialBase + acquired) * close + initialCash + cashFlow;
  };

  const points: EquityPoint[] = candles.map((c, i) => {
    const isLast = i === candles.length - 1;
    const done = isLast ? fills : fills.filter((f) => f.t <= c.t);
    return { t: c.t, price: c.close, equity: equityAt(c.close, done) };
  });

  const stratEndEquity = equityAt(end, fills);
  // Buy-and-hold: for a buy, the whole starting cash becomes base at the start;
  // for a sell, holding just means keeping the base.
  const holdEquity = buy
    ? (initialCash / start) * end
    : initialBase * end;
  const edgeVsHold = fills.length > 0 ? stratEndEquity - holdEquity : null;

  const flowBase = fills.reduce((a, f) => a + f.sizedBase, 0);
  const flowCash = fills.reduce((a, f) => a + f.cashDelta, 0);
  const filled = inBase ? Math.abs(flowBase) : Math.abs(flowCash);
  const avgFill = averageFillPrice(fills);

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
      filledFraction: s.totalSize > 0 ? filled / s.totalSize : 0,
      numberOfFills: fills.length,
      note,
    },
  };
}

/** Average price the fills achieved, in cash per base. */
function averageFillPrice(fills: BacktestFill[]): number | null {
  const base = fills.reduce((a, f) => a + Math.abs(f.sizedBase), 0);
  if (base === 0) return null;
  const cash = fills.reduce((a, f) => a + Math.abs(f.cashDelta), 0);
  return cash / base;
}
