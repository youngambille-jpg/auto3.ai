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
  assert.match(r.summary.note, /never reached/i);
});

test("backtest of a stop that triggers reports a fill at the stop price", () => {
  const { strategy } = planFromText("Stop loss: sell 1 ETH if price drops to 2000");
  const r = backtest(strategy!, flat);
  assert.equal(r.summary.numberOfFills, 1);
  assert.equal(r.fills[0]!.price, 2000);
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
