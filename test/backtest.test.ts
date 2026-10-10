import { test } from "node:test";
import assert from "node:assert/strict";

import { backtest } from "../src/backtest/engine.ts";
import { syntheticCandles } from "../src/backtest/candles.ts";
import { planFromText } from "../src/strategy/planner.ts";

const flat = Array.from({ length: 48 }, (_, i) => ({
  t: 1_700_000_000_000 + i * 3_600_000,
  open: 2000, high: 2010, low: 1990, close: 2000,
}));

test("backtest of TWAP on flat prices fills every slice", () => {
  const { strategy } = planFromText("TWAP buy 6 ETH with USDC over 6 hours");
  const r = backtest(strategy!, flat);
  assert.equal(r.summary.numberOfFills, 6);
  assert.equal(r.summary.filledFraction, 1);
  assert.equal(r.summary.avgFillPrice, 2000);
});

test("backtest of a limit that never triggers reports no fills", () => {
  const { strategy } = planFromText("Limit buy 1 ETH at 1500 with USDC");
  const r = backtest(strategy!, flat);
  assert.equal(r.summary.numberOfFills, 0);
  assert.match(r.summary.note, /never crossed/i);
});

// A buy-limit rests below the market and only fills when price comes DOWN to it.
test("a buy-limit above the market does not fill on an upward path", () => {
  const rising = Array.from({ length: 12 }, (_, i) => {
    const close = 1800 + i * 40; // 1800 -> 2240, never trades above 2240
    return { t: i, open: close - 5, high: close + 5, low: close - 5, close };
  });
  const { strategy } = planFromText("Limit buy 1 ETH at 2200 with USDC");
  const r = backtest(strategy!, rising);
  assert.equal(r.summary.numberOfFills, 0, "a buy-limit should not fill on the way up");
});

test("a buy-limit fills when price crosses down through it", () => {
  const down = [
    { t: 0, open: 2600, high: 2610, low: 2595, close: 2600 },
    { t: 1, open: 2600, high: 2600, low: 2400, close: 2450 }, // crosses 2500 down
    { t: 2, open: 2450, high: 2460, low: 2400, close: 2420 },
  ];
  const { strategy } = planFromText("Limit buy 1 ETH at 2500 with USDC");
  const r = backtest(strategy!, down);
  assert.equal(r.summary.numberOfFills, 1);
  assert.equal(r.fills[0]!.price, 2500);
});

// A stop-loss sells, and fills when price crosses DOWN through the stop.
test("a stop-loss fills when price crosses down through the stop", () => {
  const crash = [
    { t: 0, open: 2500, high: 2510, low: 2490, close: 2500 },
    { t: 1, open: 2500, high: 2500, low: 2200, close: 2250 }, // crosses 2300 down
    { t: 2, open: 2250, high: 2260, low: 2150, close: 2160 },
  ];
  const { strategy } = planFromText("Stop loss: sell 1 ETH if price drops to 2300");
  const r = backtest(strategy!, crash);
  assert.equal(r.summary.numberOfFills, 1);
  assert.equal(r.fills[0]!.price, 2300);
  // Selling 1 ETH disposes of the base and receives cash.
  assert.equal(r.fills[0]!.sizedBase, -1);
  assert.equal(r.fills[0]!.cashDelta, 2300);
});

test("grid backtest fills only on downward crossings", () => {
  const candles = [
    { t: 1, open: 2600, high: 2610, low: 2590, close: 2600 },
    { t: 2, open: 2600, high: 2600, low: 2500, close: 2500 },
    { t: 3, open: 2500, high: 2500, low: 2400, close: 2400 },
    { t: 4, open: 2400, high: 2700, low: 2400, close: 2700 },
  ];
  const { strategy } = planFromText("Grid ETH between 2400 and 2800 with 4 levels, 4 ETH total");
  const r = backtest(strategy!, candles);
  assert.ok(r.summary.numberOfFills >= 1, "expected at least one grid fill");
  assert.ok(r.points.length === candles.length);
});

test("backtest requires at least two candles", () => {
  const { strategy } = planFromText("TWAP buy 1 ETH with USDC over 1 hour");
  assert.throws(() => backtest(strategy!, [flat[0]!]));
});

test("synthetic candles are deterministic for a seed", () => {
  const a = syntheticCandles(10, 42);
  const b = syntheticCandles(10, 42);
  assert.deepEqual(a.map((c) => c.close), b.map((c) => c.close));
});

// --- ledger correctness (Phase 1.1) -----------------------------------------

test("cash-denominated TWAP: equity and hold baseline both start from the budget", () => {
  // Spend 1200 USDC into ETH, price flat at 2000. Both the strategy and a
  // buy-and-hold end with 1200 USDC of ETH, so the edge is exactly zero.
  const { strategy } = planFromText("DCA 1200 USDC into ETH over 6 hours");
  const r = backtest(strategy!, flat);
  assert.equal(r.summary.numberOfFills, 6);
  assert.ok(Math.abs(r.summary.edgeVsHold!) < 1e-6, "flat market => strategy matches hold");
  assert.ok(Math.abs(r.points.at(-1)!.equity - 1200) < 1e-6, "1200 USDC in, 1200 USDC of value out");
});

test("base-denominated TWAP: acquires the exact base amount", () => {
  // Buy 3 ETH with a flat price: filled base must be exactly 3 ETH.
  const { strategy } = planFromText("TWAP buy 3 ETH with USDC over 6 hours");
  const r = backtest(strategy!, flat);
  const base = r.fills.reduce((a, f) => a + f.sizedBase, 0);
  assert.ok(Math.abs(base - 3) < 1e-9, `expected 3 ETH acquired, got ${base}`);
  assert.equal(r.summary.filledFraction, 1);
});

test("a rising market makes a buy strategy beat holding only up to what it deployed", () => {
  // TWAP that has not finished deploying lags a hold in a rising market, so the
  // edge must be strictly negative and never a NaN.
  const rising = Array.from({ length: 24 }, (_, i) => {
    const close = 2000 + i * 20;
    return { t: i, open: close - 10, high: close + 5, low: close - 10, close };
  });
  const { strategy } = planFromText("TWAP buy 6 ETH with USDC over 6 hours");
  const r = backtest(strategy!, rising);
  assert.ok(r.summary.edgeVsHold !== null);
  assert.ok(r.summary.edgeVsHold! < 0, "undepleted cash lags a rising hold");
  assert.ok(Number.isFinite(r.summary.edgeVsHold!));
});

test("a sell campaign keeps the base as its hold baseline", () => {
  // Stop-loss sells 1 ETH. Holding means keeping 1 ETH. A flat market makes the
  // two equal; a falling market makes selling beat holding.
  const falling = [
    { t: 0, open: 2500, high: 2510, low: 2490, close: 2500 },
    { t: 1, open: 2500, high: 2500, low: 2100, close: 2150 },
    { t: 2, open: 2150, high: 2160, low: 1900, close: 1950 },
  ];
  const { strategy } = planFromText("Stop loss: sell 1 ETH if price drops to 2300");
  const r = backtest(strategy!, falling);
  assert.equal(r.summary.numberOfFills, 1);
  // Sold at 2300 vs holding to 1950 => edge = 350.
  assert.ok(Math.abs(r.summary.edgeVsHold! - 350) < 1e-6, `edge was ${r.summary.edgeVsHold}`);
});
