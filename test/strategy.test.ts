import { test } from "node:test";
import assert from "node:assert/strict";
const WALLET = "0x24De7FeED9632fD61784973548ce11573DB9C141";

import { planFromText, validateStrategy, detectChainId } from "../src/strategy/planner.ts";
import { compileStrategy } from "../src/strategy/compile.ts";
import { decimalToRaw, rawToDecimal } from "../src/strategy/units.ts";

test("detectChainId defaults to Arbitrum One and does not honor Sepolia", () => {
  assert.equal(detectChainId("do something on arbitrum"), "42161");
  // Sepolia is not executable here, so it is not selected; validate rejects it.
  assert.equal(detectChainId("twap on arbitrum sepolia"), "42161");
});

test("validateStrategy rejects Arbitrum Sepolia as non-executable", () => {
  const { strategy } = planFromText("TWAP buy 1 ETH with USDC over 2 hours");
  const onSepolia = { ...strategy!, chainId: "421614" };
  const v = validateStrategy(onSepolia);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /Sepolia is not executable/i);
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

test("a price read uses the native Chainlink action and a structured ref", () => {
  const { strategy } = planFromText("Limit buy 1 ETH at 2400 with USDC");
  const wf = compileStrategy(strategy!, WALLET);
  const read = wf.nodes.find((n) => (n.data.config as { actionType?: string }).actionType === "chainlink/eth-usd-latest-round-data");
  assert.ok(read, "expected the native ETH/USD read");
  // No hand-rolled ABI read for a symbol the native action covers.
  assert.ok(!wf.nodes.some((n) => (n.data.config as { actionType?: string }).actionType === "web3/read-contract"));
  const cond = wf.nodes.find((n) => (n.data.config as { actionType?: string }).actionType === "Condition");
  const rule = (cond!.data.config as { conditionConfig: { group: { rules: Array<{ leftOperand: string }> } } })
    .conditionConfig.group.rules[0]!;
  assert.match(rule.leftOperand, /Read ETH\/USD\.result\.answer\}\}$/);
});

test("an uncovered symbol falls back to a read-contract over the feed registry", () => {
  const { strategy } = planFromText("Limit buy 1 ARB at 2 with USDC");
  assert.equal(strategy!.buySymbol, "ARB");
  const wf = compileStrategy(strategy!, WALLET);
  const read = wf.nodes.find((n) => (n.data.config as { actionType?: string }).actionType === "web3/read-contract");
  assert.ok(read, "expected the generic read-contract fallback");
  assert.ok(!wf.nodes.some((n) => (n.data.config as { actionType?: string }).actionType === "chainlink/eth-usd-latest-round-data"));
});

test("the approve is guarded by an allowance check on the true branch", () => {
  const { strategy } = planFromText("TWAP buy 5 ETH with USDC over 6 hours");
  const wf = compileStrategy(strategy!, WALLET, { sellUsd: 1, buyUsd: 2500 });
  const chk = wf.nodes.find((n) => (n.data.config as { actionType?: string }).actionType === "web3/check-allowance");
  assert.ok(chk, "expected a check-allowance node");
  const cfg = chk!.data.config as { ownerAddress: string; spenderAddress: string };
  assert.equal(cfg.ownerAddress, WALLET);
  assert.match(cfg.spenderAddress, /^0x[0-9a-fA-F]{40}$/);
  // The approve is only reached when the allowance condition is true.
  const guardEdge = wf.edges.find((e) => e.target === "approve-1");
  assert.ok(guardEdge);
  assert.equal(guardEdge!.sourceHandle, "true");
  assert.equal(guardEdge!.source, "cond-allow");
  // The Condition tests the raw allowance against the required amount.
  const cond = wf.nodes.find((n) => n.id === "cond-allow")!;
  const rule = (cond.data.config as { conditionConfig: { group: { rules: Array<{ operator: string; leftOperand: string }> } } })
    .conditionConfig.group.rules[0]!;
  assert.equal(rule.operator, "<");
  assert.match(rule.leftOperand, /Check USDC allowance\.allowanceRaw\}\}$/);
});

test("every node is wired: no orphan nodes and no dangling edges", () => {
  for (const prompt of [
    "TWAP buy 5 ETH with USDC over 6 hours",
    "Limit buy 1 ETH at 2400 with USDC",
    "Stop loss: sell 1 ETH if price drops to 2200",
    "Grid ETH between 2400 and 2800 with 4 levels, 2 ETH total",
  ]) {
    const { strategy } = planFromText(prompt);
    const wf = compileStrategy(strategy!, WALLET, { sellUsd: 1, buyUsd: 2500 });
    const ids = new Set(wf.nodes.map((n) => n.id));
    for (const e of wf.edges) {
      assert.ok(ids.has(e.source), `missing source ${e.source} in ${prompt}`);
      assert.ok(ids.has(e.target), `missing target ${e.target} in ${prompt}`);
    }
    const reached = new Set(wf.edges.flatMap((e) => [e.source, e.target]));
    for (const n of wf.nodes) {
      assert.ok(reached.has(n.id), `orphan node ${n.id} in ${prompt}`);
    }
    // Condition groups must not share ids across nodes.
    const groupIds = wf.nodes
      .map((n) => (n.data.config as { conditionConfig?: { group: { id: string } } }).conditionConfig?.group.id)
      .filter((x): x is string => Boolean(x));
    assert.equal(new Set(groupIds).size, groupIds.length, `duplicate condition group ids in ${prompt}`);
  }
});
