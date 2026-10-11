import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rankTemplates,
  looksLikeOnchainNeed,
  isTradingTemplate,
  type TemplateSummary,
} from "../src/keeperhub/templates.ts";

const CATALOG: TemplateSummary[] = [
  { id: "t1", name: "Aave V3 Auto-Repay on Low Health", description: "Checks your Aave V3 health factor and repays when it drops.", isTradingStrategy: false },
  { id: "t2", name: "Aave V3 Health Factor Guardian", description: "Monitors your lending position and alerts you.", isTradingStrategy: false },
  { id: "t3", name: "Lido stETH Auto-Wrapper", description: "Wraps stETH to wstETH on a schedule.", isTradingStrategy: false },
  { id: "t4", name: "WETH Auto-Wrap ETH on Schedule", description: "Wraps ETH into WETH.", isTradingStrategy: false },
  { id: "t5", name: "dca-0x89f97c-1785768081790", description: "", isTradingStrategy: true },
];

test("looksLikeOnchainNeed flags monitoring and yield asks, not trades", () => {
  assert.ok(looksLikeOnchainNeed("Monitor my Aave health factor"));
  assert.ok(looksLikeOnchainNeed("stake my ETH with Lido"));
  assert.ok(looksLikeOnchainNeed("watch my yearn vault"));
  assert.ok(!looksLikeOnchainNeed("TWAP buy 5 ETH with USDC over 6 hours"));
  assert.ok(!looksLikeOnchainNeed("Limit buy 1 ETH at 2400 with USDC"));
});

test("isTradingTemplate recognises the strategy words our compiler owns", () => {
  assert.ok(isTradingTemplate("my dca workflow"));
  assert.ok(isTradingTemplate("Grid bot", "grid trading"));
  assert.ok(isTradingTemplate("stop loss guard"));
  assert.ok(!isTradingTemplate("Aave V3 Health Factor Guardian", "monitors your position"));
});

test("rankTemplates puts the closest name match first", () => {
  const ranked = rankTemplates("monitor aave health factor and repay", CATALOG);
  assert.ok(ranked.length >= 2);
  assert.equal(ranked[0]!.id, "t1", "auto-repay matches 'repay' + 'aave' + 'health'");
  assert.ok(ranked.some((t) => t.id === "t2"));
  // Nothing about Lido or wrapping should surface.
  assert.ok(!ranked.some((t) => t.id === "t3" || t.id === "t4"));
});

test("rankTemplates returns nothing for an unrelated prompt", () => {
  assert.deepEqual(rankTemplates("xyzzy plugh frobnicate", CATALOG), []);
});

test("rankTemplates caps the number of suggestions", () => {
  const many: TemplateSummary[] = Array.from({ length: 10 }, (_, i) => ({
    id: `x${i}`,
    name: `Aave health monitor ${i}`,
    description: "aave health",
    isTradingStrategy: false,
  }));
  assert.equal(rankTemplates("aave health", many, 3).length, 3);
});
