/**
 * Live integration test. Runs only when KEEPERHUB_API_KEY is set, and cleans up
 * after itself. It proves the whole pipeline against the real KeeperHub API:
 * compile -> create workflow -> execute -> poll -> read logs -> delete.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { planFromText } from "../src/strategy/planner.ts";
import { compileStrategy } from "../src/strategy/compile.ts";
import { keeperHub } from "../src/keeperhub/client.ts";
import { keeperHubMcp } from "../src/keeperhub/mcp.ts";

const hasKey = Boolean(process.env.KEEPERHUB_API_KEY);

test("live: auth and chains", { skip: !hasKey }, async () => {
  const me = await keeperHub.me();
  assert.ok(me.id, "expected a user id from KeeperHub");
  const chains = await keeperHub.chains();
  assert.ok(chains.some((c) => c.chainId === 42161), "Arbitrum One should be available");
});

test("live: create and delete a compiled TWAP workflow (no broadcast)", { skip: !hasKey }, async () => {
  const { strategy } = planFromText("TWAP buy 0.001 ETH with USDC over 1 hour");
  assert.ok(strategy);
  const wallet = await keeperHub.wallet();
  const recipient = wallet.find((i) => i.type === "web3")?.address ?? "";
  const wf = compileStrategy(strategy!, recipient);

  const created = await keeperHub.createWorkflow({
    name: `[test] ${wf.name}`,
    description: wf.description,
    nodes: wf.nodes,
    edges: wf.edges,
  });
  assert.ok(created.id, "workflow should be created");
  const del = await keeperHub.deleteWorkflow(created.id);
  assert.equal(del.success, true);
});

test("live: execute a read-only workflow end to end", { skip: !hasKey }, async () => {
  const created = await keeperHub.createWorkflow({
    name: "[test] read balance",
    description: "harmless read-only probe",
    nodes: [
      { id: "trigger-1", type: "trigger", data: { label: "Manual", config: { triggerType: "Manual" } } },
      {
        id: "step-1",
        type: "action",
        data: {
          label: "Read balance",
          config: {
            actionType: "web3/check-balance",
            network: "42161",
            address: "0x24De7FeED9632fD61784973548ce11573DB9C141",
          },
        },
      },
    ],
    edges: [{ id: "e1", source: "trigger-1", target: "step-1" }],
  });
  assert.ok(created.id);
  try {
    const run = await keeperHub.executeWorkflow(created.id, {});
    assert.ok(run.executionId);
    const receipt = await keeperHub.waitForReceipt(run.executionId, 30_000);
    assert.equal(receipt.status, "success");
    const logs = await keeperHub.executionLogs(run.executionId);
    assert.ok(logs.logs.some((l) => l.status === "success"));
  } finally {
    const del = await keeperHub.deleteWorkflow(created.id);
    assert.equal(del.success, true);
  }
});

test("live: a compiled workflow validates clean over MCP", { skip: !hasKey }, async () => {
  const { strategy } = planFromText("Limit buy 1 ETH at 2400 with USDC");
  assert.ok(strategy);
  const wallet = await keeperHub.wallet();
  const recipient = wallet.find((i) => i.type === "web3")?.address ?? "";
  const wf = compileStrategy(strategy!, recipient, { sellUsd: 1, buyUsd: 2500 });

  const created = await keeperHub.createWorkflow({
    name: `[test] validate ${wf.name}`,
    description: wf.description,
    nodes: wf.nodes,
    edges: wf.edges,
    enabled: false,
  });
  assert.ok(created.id);
  try {
    const v = await keeperHubMcp.validateWorkflow(created.id);
    assert.equal(v.valid, true, "compiled workflow should be valid");
    // The check-allowance gate is what removed the old
    // approve-without-allowance-check warning.
    const codes = (v.warnings ?? []).map((w) => w.code);
    assert.ok(!codes.includes("approve-without-allowance-check"), `unexpected warning: ${codes}`);
  } finally {
    await keeperHub.deleteWorkflow(created.id);
  }
});

test("live: an exact-output quote caps the compiled swap", { skip: !hasKey }, async () => {
  const { strategy } = planFromText("TWAP buy 0.05 ETH with USDC over 2 hours");
  assert.ok(strategy);
  assert.equal(strategy!.sizeUnit, "buy");
  const { resolveMarketContext, compileWithContext } = await import("../src/server/context.ts");
  const ctx = await resolveMarketContext(strategy!);
  assert.ok(ctx.swapBudget && ctx.swapBudget > 0, "expected a live swap budget");
  const wf = compileWithContext(strategy!, ctx);
  const swap = wf.nodes.find(
    (n) => (n.data.config as { actionType?: string }).actionType === "uniswap/swap-exact-output",
  );
  assert.ok(swap, "buy-denominated strategies compile to an exact-output swap");
  const cap = BigInt((swap!.data.config as { amountInMaximum: string }).amountInMaximum);
  // The cap must cover the quoted budget (the quote is min()'d with a 5% oracle buffer).
  assert.ok(cap >= BigInt(Math.floor(ctx.swapBudget!)), `cap ${cap} below budget ${ctx.swapBudget}`);
});

