import { test } from "node:test";
import assert from "node:assert/strict";
const WALLET = "0x24De7FeED9632fD61784973548ce11573DB9C141";

import { planFromText, validateStrategy, detectChainId } from "../src/strategy/planner.ts";
import { compileStrategy } from "../src/strategy/compile.ts";
import { decimalToRaw, rawToDecimal } from "../src/strategy/units.ts";

test("detectChainId defaults to configured chain and honors Sepolia", () => {
  assert.equal(detectChainId("do something on arbitrum"), "42161");
  assert.equal(detectChainId("twap on arbitrum sepolia"), "421614");
});

test("units round-trip exactly", () => {
  assert.equal(decimalToRaw("1.5", 18), "1500000000000000000");
  assert.equal(decimalToRaw(5, 6), "5000000");
  assert.equal(rawToDecimal("1500000000000000000", 18), "1.5");
  assert.equal(rawToDecimal("1500000", 6), "1.5");
});

test("TWAP plan produces slices and interval", () => {
  const { strategy, error } = planFromText("TWAP buy 5 ETH with USDC over 6 hours");
  assert.equal(error, undefined);
  assert.equal(strategy!.kind, "twap");
  assert.equal(strategy!.sellSymbol, "USDC");
  assert.equal(strategy!.buySymbol, "ETH");
  assert.equal(strategy!.totalSize, 5);
  assert.equal(strategy!.slices, 6);
  assert.equal(strategy!.intervalMinutes, 60);
  assert.ok(validateStrategy(strategy).ok);
});

test("grid plan parses range and levels", () => {
  const { strategy } = planFromText("Grid ETH between 2400 and 2800 with 10 levels, 2 ETH total");
  assert.equal(strategy!.kind, "grid");
  const g = strategy as Extract<typeof strategy, { kind: "grid" }>;
  assert.equal(g.lowerPrice, 2400);
  assert.equal(g.upperPrice, 2800);
  assert.equal(g.levels, 10);
  assert.equal(g.totalSize, 2);
  assert.ok(validateStrategy(strategy).ok);
});

test("limit plan parses trigger price", () => {
  const { strategy } = planFromText("Limit buy 1 ETH at 2400 with USDC");
  assert.equal(strategy!.kind, "limit");
  const l = strategy as Extract<typeof strategy, { kind: "limit" }>;
  assert.equal(l.limitPrice, 2400);
  assert.equal(l.side, "buy");
  assert.ok(validateStrategy(strategy).ok);
});

test("stop plan parses sell side", () => {
  const { strategy } = planFromText("Stop loss: sell 1 ETH if price drops to 2200");
  assert.equal(strategy!.kind, "stop");
  const s = strategy as Extract<typeof strategy, { kind: "stop" }>;
  assert.equal(s.stopPrice, 2200);
  assert.equal(s.side, "sell");
  assert.ok(validateStrategy(strategy).ok);
});

test("ambiguous prompt yields an error, not a broken strategy", () => {
  const { strategy, error } = planFromText("do something profitable");
  assert.equal(strategy, undefined);
  assert.ok(error);
});

test("validateStrategy rejects bad input", () => {
  const v = validateStrategy({ kind: "twap", chainId: "1", sellToken: "nope", buyToken: "nope", totalSize: -1, slices: 1, intervalMinutes: 0 } as never);
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 3);
});

test("compileStrategy produces valid nodes and edges for TWAP", () => {
  const { strategy } = planFromText("TWAP sell 5 ETH for USDC over 6 hours");
  const wf = compileStrategy(strategy!, WALLET);
  assert.equal(wf.nodes[0]!.type, "trigger");
  assert.equal((wf.nodes[0]!.data.config as { triggerType: string }).triggerType, "Schedule");
  const swap = wf.nodes.find((n) => (n.data.config as { actionType?: string }).actionType === "uniswap/swap-exact-input");
  assert.ok(swap);
  // every edge points at a real node
  const ids = new Set(wf.nodes.map((n) => n.id));
  for (const e of wf.edges) {
    assert.ok(ids.has(e.source), `missing source ${e.source}`);
    assert.ok(ids.has(e.target), `missing target ${e.target}`);
  }
  assert.ok(wf.steps.length >= 2);
});

test("compileStrategy for limit uses a Condition with true handle", () => {
  const { strategy } = planFromText("Limit buy 1 ETH at 2400 with USDC");
  const wf = compileStrategy(strategy!, WALLET);
  const cond = wf.nodes.find((n) => (n.data.config as { actionType?: string }).actionType === "Condition");
  assert.ok(cond);
  assert.ok(wf.edges.some((e) => e.sourceHandle === "true"));
});

test("compileStrategy for grid stays within nodes referenced by edges", () => {
  const { strategy } = planFromText("Grid ETH between 2400 and 2800 with 4 levels, 2 ETH total");
  const wf = compileStrategy(strategy!, WALLET, { sellUsd: 1, buyUsd: 2500 });
  const ids = new Set(wf.nodes.map((n) => n.id));
  for (const e of wf.edges) {
    assert.ok(ids.has(e.source));
    assert.ok(ids.has(e.target));
  }
});

test("a buy-denominated size compiles to an exact-output swap", () => {
  const { strategy } = planFromText("TWAP buy 5 ETH with USDC over 6 hours");
  assert.equal(strategy!.sizeUnit, "buy");
  assert.ok(validateStrategy(strategy).ok);
  const wf = compileStrategy(strategy!, WALLET, { sellUsd: 1, buyUsd: 2500 });
  const swap = wf.nodes.find(
    (n) => (n.data.config as { actionType?: string }).actionType === "uniswap/swap-exact-output",
  );
  assert.ok(swap, "expected an exact-output swap node");
  const cfg = swap!.data.config as { amountOut: string; amountInMaximum: string; tokenIn: string };
  // 5 ETH over 6 slices = 0.8333 ETH per slice, in wei.
  assert.equal(cfg.amountOut, "833333333333333400");
  // Cap is the oracle value of 5/6 ETH (2500 * 5/6 * 1.05 ~= 2187.5 USDC) in USDC wei.
  assert.equal(cfg.amountInMaximum, "2187500000");
  assert.ok(!wf.nodes.some((n) => (n.data.config as { actionType?: string }).actionType === "uniswap/swap-exact-input"));
});

test("a cash-denominated size compiles to an exact-input swap", () => {
  const { strategy } = planFromText("TWAP spend 100 USDC to buy ETH over 6 hours");
  assert.equal(strategy!.sizeUnit, "sell");
  assert.equal(strategy!.sellSymbol, "USDC");
  const wf = compileStrategy(strategy!, WALLET, { sellUsd: 1, buyUsd: 2492 });
  const swap = wf.nodes.find(
    (n) => (n.data.config as { actionType?: string }).actionType === "uniswap/swap-exact-input",
  );
  assert.ok(swap, "expected an exact-input swap node");
  // 100 USDC over 6 slices, 6 decimals.
  const cfg = swap!.data.config as { amountIn: string };
  assert.equal(cfg.amountIn, "16666666");
});

test("a grid sized in the acquired asset is buy-denominated", () => {
  const { strategy } = planFromText("Grid ETH between 2400 and 2800 with 4 levels, 2 ETH total");
  assert.equal(strategy!.sizeUnit, "buy");
  assert.equal(strategy!.totalSize, 2);
  assert.equal((strategy as { levels: number }).levels, 4);
});
