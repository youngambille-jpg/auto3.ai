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
