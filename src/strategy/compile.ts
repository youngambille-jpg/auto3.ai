/**
 * Compile a validated strategy spec into a KeeperHub workflow definition
 * (nodes + edges). This is the whole "backend logic" layer, and it is pure so
 * it can be unit tested without touching the network.
 *
 * Node/edge shapes follow the KeeperHub schema:
 *   - trigger nodes: { id, type: "trigger", data: { label, config: { triggerType, ... } } }
 *   - action nodes:  { id, type: "action",  data: { label, config: { actionType, ... } } }
 *   - Condition nodes branch through sourceHandle "true"/"false".
 *   - template refs: "{{@nodeId:Label.field}}"
 */

import type { Strategy } from "./spec.js";
import { decimalToRaw } from "./units.js";
import { findToken } from "./tokens.js";
import { isStable, usdFeedFor, nativeFeedAction, CHAINLINK_ABI } from "./prices.js";
import { DEFAULT_FEE } from "./tokens.js";

/**
 * Chain where swaps, approvals and Chainlink reads all exist: Arbitrum One.
 * Strategies are only executable here (Uniswap V3 is not deployed on Sepolia in
 * KeeperHub), so the compiler refuses other chains rather than emitting a
 * workflow that would fail at save time.
 */
export const EXECUTION_CHAIN = "42161";

export interface WorkflowNode {
  id: string;
  type: "trigger" | "action";
  data: {
    label: string;
    type?: "trigger" | "action";
    description?: string;
    config: Record<string, unknown>;
    status?: "idle";
  };
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: "true" | "false";
}

export interface Workflow {
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface CompiledWorkflow extends Workflow {
  /** Human steps shown on the preview card. */
  steps: string[];
}

function action(
  id: string,
  label: string,
  config: Record<string, unknown>,
  description?: string,
): WorkflowNode {
  return {
    id,
    type: "action",
    data: { label, type: "action", config, ...(description ? { description } : {}), status: "idle" },
  };
}

function scheduleTrigger(id: string, intervalMinutes: number): WorkflowNode {
  const cron = intervalMinutes % 60 === 0
    ? `0 */${Math.max(1, Math.round(intervalMinutes / 60))} * * *`
    : `*/${Math.max(1, intervalMinutes)} * * * *`;
  return {
    id,
    type: "trigger",
    data: { label: "Schedule", type: "trigger", config: { triggerType: "Schedule", scheduleCron: cron, scheduleTimezone: "UTC" }, status: "idle" },
  };
}

function manualTrigger(id: string): WorkflowNode {
  return { id, type: "trigger", data: { label: "Manual", type: "trigger", config: { triggerType: "Manual" }, status: "idle" } };
}

/** Uniswap V3 SwapRouter02 on Arbitrum One. */
const UNISWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";

/** KeeperHub token selection config for a known token address. */
function tokenConfig(s: Strategy): string {
  const token = findToken(s.chainId, s.sellToken);
  return JSON.stringify({
    mode: "custom",
    customToken: { address: s.sellToken, symbol: s.sellSymbol, decimals: token?.decimals ?? 18 },
  });
}

/**
 * A USD price read for `symbol`, preferring KeeperHub's native Chainlink action
 * and falling back to a generic read over our address registry. Returns the node
 * plus the template ref to its raw (8-decimal) answer.
 */
function priceRead(id: string, label: string, symbol: string): { node: WorkflowNode; ref: string } | undefined {
  const native = nativeFeedAction(symbol);
  if (native) {
    return {
      node: action(id, label, { actionType: native, network: EXECUTION_CHAIN }, `${symbol}/USD via KeeperHub's native Chainlink read`),
      ref: `{{@${id}:${label}.result.answer}}`,
    };
  }
  const feed = usdFeedFor(symbol);
  if (!feed) return undefined;
  return {
    node: action(id, label, {
      actionType: "web3/read-contract",
      network: EXECUTION_CHAIN,
      contractAddress: feed.address,
      abi: CHAINLINK_ABI,
      abiFunction: "latestAnswer",
    }, `${feed.symbol} Chainlink price feed, 8 decimals`),
    ref: `{{@${id}:${label}.result}}`,
  };
}

function conditionNode(
  id: string,
  ref: string,
  op: string,
  value: string,
  description?: string,
): WorkflowNode {
  return action(id, "Condition", {
    actionType: "Condition",
    condition: `${ref} ${op} ${value}`,
    conditionConfig: {
      group: {
        id: `g-${id}`,
        logic: "AND",
        rules: [{ id: `r-${id}`, leftOperand: ref, operator: op, rightOperand: value }],
      },
    },
  }, description);
}

function swapNode(
  id: string,
  label: string,
  s: Strategy,
  amountInRaw: string,
  recipient: string,
  amountOutMinimum = "0",
): WorkflowNode {
  return action(
    id,
    label,
    {
      actionType: "uniswap/swap-exact-input",
      network: s.chainId,
      tokenIn: s.sellToken,
      tokenOut: s.buyToken,
      fee: s.fee || DEFAULT_FEE,
      recipient,
      amountIn: amountInRaw,
      amountOutMinimum,
    },
    `Swap ${amountInRaw} of ${s.sellSymbol} -> ${s.buySymbol}`,
  );
}

/**
 * Exact-output swap: acquire `amountOutRaw` of the buy token, spending at most
 * `amountInMaximumRaw` of the sell token. Used when a size is denominated in the
 * buy token ("buy 2 ETH"). The cap comes from the live oracle so a stale or
 * manipulated pool cannot drain the wallet.
 */
function swapExactOutputNode(
  id: string,
  label: string,
  s: Strategy,
  amountOutRaw: string,
  amountInMaximumRaw: string,
  recipient: string,
): WorkflowNode {
  return action(
    id,
    label,
    {
      actionType: "uniswap/swap-exact-output",
      network: s.chainId,
      tokenIn: s.sellToken,
      tokenOut: s.buyToken,
      fee: s.fee || DEFAULT_FEE,
      recipient,
      amountOut: amountOutRaw,
      amountInMaximum: amountInMaximumRaw,
    },
    `Acquire ${amountOutRaw} of ${s.buySymbol}, spending at most ${amountInMaximumRaw} of ${s.sellSymbol}`,
  );
}

/** Live USD prices used to bound exact-output swaps; any value may be missing. */
export interface CompilePrices {
  sellUsd?: number;
  buyUsd?: number;
}

/**
 * Build the swap step for a leg size. Buy-denominated strategies go through an
 * exact-output swap with an oracle-derived cap; everything else uses exact-input.
 */
function legSwapNode(
  id: string,
  label: string,
  s: Strategy,
  sellAmount: number,
  buyAmount: number,
  sellDecimals: number,
  buyDecimals: number,
  recipient: string,
  prices: CompilePrices,
): WorkflowNode {
  if (s.sizeUnit === "buy") {
    const cap = oracleInputCap(s, buyAmount, prices);
    return swapExactOutputNode(id, label, s, decimalToRaw(buyAmount, buyDecimals), decimalToRaw(cap, sellDecimals), recipient);
  }
  return swapNode(id, label, s, decimalToRaw(sellAmount, sellDecimals), recipient);
}

/**
 * Upper bound on the sell-token amount for an exact-output swap, derived from
 * USD prices (with a 5% buffer). Falls back to the buy amount itself when a
 * price is missing, which makes the cap tight rather than draining the wallet.
 */
function oracleInputCap(s: Strategy, buyAmount: number, prices: CompilePrices): number {
  const sellPrice = isStable(s.sellSymbol) ? 1 : prices.sellUsd;
  const buyPrice = isStable(s.buySymbol) ? 1 : prices.buyUsd;
  if (!sellPrice || !buyPrice) return buyAmount;
  const fair = (buyAmount * buyPrice) / sellPrice;
  return fair * 1.05;
}

function approveNode(id: string, s: Strategy, amountRaw: string): WorkflowNode {
  return action(id, `Approve ${s.sellSymbol}`, {
    actionType: "web3/approve-token",
    network: s.chainId,
    tokenConfig: tokenConfig(s),
    spenderAddress: UNISWAP_ROUTER,
    amount: amountRaw,
  }, "Allowance so the router can move your sell token");
}

/**
 * Guard the approve so it only sends a transaction when the current allowance is
 * short. Emits three nodes — a read, a Condition, and the approve — plus edges:
 *
 *   ... -> read -> cond --(true: allowance short)--> approve
 *                     \--(false: already covered)--> (skip; joins at `mergeId`)
 *
 * Returns the edges to splice in and the node id that follows the guard.
 */
function allowanceGate(
  readId: string,
  condId: string,
  approve: WorkflowNode,
  s: Strategy,
  amountRaw: string,
  ownerAddress: string,
  incoming: { source: string; sourceHandle?: "true" | "false" },
): { nodes: WorkflowNode[]; edges: WorkflowEdge[]; joinId: string } {
  const read = action(readId, `Check ${s.sellSymbol} allowance`, {
    actionType: "web3/check-allowance",
    network: s.chainId,
    tokenConfig: tokenConfig(s),
    ownerAddress,
    spenderAddress: UNISWAP_ROUTER,
  }, `Reads the current allowance before deciding to approve`);

  const cond = conditionNode(
    condId,
    `{{@${readId}:Check ${s.sellSymbol} allowance.allowanceRaw}}`,
    "<",
    amountRaw,
    "Approve only when the allowance is short",
  );

  const edges: WorkflowEdge[] = [
    { id: `${readId}-in`, source: incoming.source, target: readId, ...(incoming.sourceHandle ? { sourceHandle: incoming.sourceHandle } : {}) },
    { id: `${readId}-cond`, source: readId, target: condId },
    { id: `${condId}-approve`, source: condId, target: approve.id, sourceHandle: "true" },
  ];

  return { nodes: [read, cond, approve], edges, joinId: approve.id };
}

/**
 * Compile a strategy. Throws if the strategy is not executable (e.g. swaps on a
 * chain where the DEX is not deployed).
 */
export function compileStrategy(
  s: Strategy,
  recipient: string,
  prices: CompilePrices = {},
): CompiledWorkflow {
  if (s.chainId !== EXECUTION_CHAIN) {
    throw new Error(
      `Uniswap V3 is not deployed on chain ${s.chainId} in KeeperHub. Execute on Arbitrum One (${EXECUTION_CHAIN}).`,
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new Error("A wallet (recipient) address is required to compile swap steps. Connect a KeeperHub web3 wallet.");
  }
  const sellDecimals = findToken(s.chainId, s.sellToken)?.decimals ?? 18;
  const buyDecimals = findToken(s.chainId, s.buyToken)?.decimals ?? 18;

  if (s.kind === "twap" || s.kind === "dca") {
    const perSlice = s.totalSize / s.slices;
    const buyDenominated = s.sizeUnit === "buy";
    const swap = legSwapNode(
      "swap-1",
      buyDenominated
        ? `Acquire slice (${perSlice} ${s.buySymbol})`
        : `Swap slice (${perSlice} ${s.sellSymbol})`,
      s,
      perSlice,
      perSlice,
      sellDecimals,
      buyDecimals,
      recipient,
      prices,
    );
    const approveTotal = buyDenominated ? oracleInputCap(s, s.totalSize, prices) : s.totalSize;
    const totalRaw = decimalToRaw(approveTotal, sellDecimals);
    const approve = approveNode("approve-1", s, totalRaw);
    const gate = allowanceGate("allow-1", "cond-allow", approve, s, totalRaw, recipient, { source: "trigger-1" });
    const nodes: WorkflowNode[] = [scheduleTrigger("trigger-1", s.intervalMinutes), ...gate.nodes, swap];
    const edges: WorkflowEdge[] = [...gate.edges, { id: "e-swap", source: gate.joinId, target: "swap-1" }];
    const perSliceLabel = buyDenominated ? `${perSlice} ${s.buySymbol}` : `${perSlice} ${s.sellSymbol}`;
    return {
      name: `${s.kind.toUpperCase()} buy ${s.totalSize} ${s.buySymbol} with ${s.sellSymbol}`,
      description: `${s.slices} slices of ${perSliceLabel} every ${s.intervalMinutes} minutes.`,
      nodes,
      edges,
      steps: [
        `Every ${s.intervalMinutes} min, one scheduled run fires.`,
        `Approve ${s.sellSymbol} for the Uniswap router only when the allowance is short.`,
        buyDenominated
          ? `Acquire ${perSlice} ${s.buySymbol} per slice (spending at most the oracle-capped ${s.sellSymbol}).`
          : `Swap ${perSlice} ${s.sellSymbol} -> ${s.buySymbol} (slice executed on schedule).`,
      ],
    };
  }

  if (s.kind === "limit" || s.kind === "stop") {
    // The trigger is expressed in USD terms of the risky asset (e.g. ETH at
    // $2400), so read the non-stable leg's feed regardless of which side is cash.
    const priceSymbol = isStable(s.sellSymbol) ? s.buySymbol : s.sellSymbol;
    const read = priceRead("read-1", `Read ${priceSymbol}/USD`, priceSymbol);
    if (!read) throw new Error(`No Chainlink price feed for ${priceSymbol}.`);
    const price = s.kind === "limit" ? s.limitPrice : s.stopPrice;
    const rawPrice = decimalToRaw(price, 8);
    // buy limit fires on a dip (<=); sell limit takes profit (>=). Stop-loss
    // (sell) fires on a drop (<=); a stop-buy fires on a rise (>=).
    const op = s.side === "buy"
      ? (s.kind === "limit" ? "<=" : ">=")
      : (s.kind === "limit" ? ">=" : "<=");
    const condition = conditionNode("cond-1", read.ref, op, rawPrice);
    const buyDenominated = s.sizeUnit === "buy";
    const approveTotal = buyDenominated ? oracleInputCap(s, s.totalSize, prices) : s.totalSize;
    const totalRaw = decimalToRaw(approveTotal, sellDecimals);
    const swap = legSwapNode(
      "swap-1",
      buyDenominated ? `Acquire on trigger` : `Swap on trigger`,
      s,
      s.totalSize,
      s.totalSize,
      sellDecimals,
      buyDecimals,
      recipient,
      prices,
    );
    const approve = approveNode("approve-1", s, totalRaw);
    const gate = allowanceGate("allow-1", "cond-allow", approve, s, totalRaw, recipient, { source: "cond-1", sourceHandle: "true" });
    const nodes: WorkflowNode[] = [
      scheduleTrigger("trigger-1", 5),
      read.node,
      condition,
      ...gate.nodes,
      swap,
    ];
    const edges: WorkflowEdge[] = [
      { id: "e1", source: "trigger-1", target: "read-1" },
      { id: "e2", source: "read-1", target: "cond-1" },
      ...gate.edges,
      { id: "e-swap", source: gate.joinId, target: "swap-1" },
    ];
    const when = s.kind === "limit"
      ? `price ${op} ${price} USD`
      : `stop price ${op} ${price} USD`;
    const sizeLabel = buyDenominated ? `${s.totalSize} ${s.buySymbol}` : `${s.totalSize} ${s.sellSymbol}`;
    return {
      name: `${s.kind === "limit" ? "Limit" : "Stop"} ${s.side} ${sizeLabel}`,
      description: `Checks ${priceSymbol}/USD every 5 minutes; swaps ${s.sellSymbol} -> ${s.buySymbol} (${sizeLabel}) when the ${when}.`,
      nodes,
      edges,
      steps: [
        "Check Chainlink price every 5 minutes.",
        `When ${priceSymbol}/USD ${op} ${price}, fire.`,
        buyDenominated
          ? `Approve ${s.sellSymbol} only if the allowance is short, then acquire ${sizeLabel} (spending at most the oracle-capped amount).`
          : `Approve ${s.sellSymbol} only if the allowance is short, then swap ${sizeLabel} -> ${s.buySymbol}.`,
      ],
    };
  }

  if (s.kind === "grid") {
    const priceSymbol = isStable(s.sellSymbol) ? s.buySymbol : s.sellSymbol;
    const read = priceRead("read-1", `Read ${priceSymbol}/USD`, priceSymbol);
    if (!read) throw new Error(`No Chainlink price feed for ${priceSymbol}.`);
    const rawHigh = decimalToRaw(s.upperPrice, 8);
    const rawLow = decimalToRaw(s.lowerPrice, 8);
    const perLevel = s.totalSize / s.levels;
    const buyDenominated = s.sizeUnit === "buy";
    const approveTotal = buyDenominated ? oracleInputCap(s, s.totalSize, prices) : s.totalSize;
    const totalRaw = decimalToRaw(approveTotal, sellDecimals);

    const swap = legSwapNode(
      "swap-buy-1",
      buyDenominated ? "Grid acquire (in-range)" : "Grid buy (in-range)",
      s,
      perLevel,
      perLevel,
      sellDecimals,
      buyDecimals,
      recipient,
      prices,
    );
    // A single-level-per-run grid: each scheduled check that finds the price
    // inside the band places one level-sized buy. Fine-grained grids would use
    // KeeperHub state to track which levels are filled; this MVP keeps one guard.
    const approve = approveNode("approve-1", s, totalRaw);
    const gate = allowanceGate("allow-1", "cond-allow", approve, s, totalRaw, recipient, { source: "cond-above-low", sourceHandle: "true" });
    const nodes: WorkflowNode[] = [
      scheduleTrigger("trigger-1", 5),
      read.node,
      conditionNode("cond-in", read.ref, "<=", rawHigh),
      conditionNode("cond-above-low", read.ref, ">=", rawLow),
      ...gate.nodes,
      swap,
    ];
    const edges: WorkflowEdge[] = [
      { id: "e1", source: "trigger-1", target: "read-1" },
      { id: "e2", source: "read-1", target: "cond-in" },
      { id: "e3", source: "cond-in", target: "cond-above-low", sourceHandle: "true" },
      ...gate.edges,
      { id: "e-swap", source: gate.joinId, target: "swap-buy-1" },
    ];
    return {
      name: `Grid ${s.sellSymbol}->${s.buySymbol} ${s.lowerPrice}-${s.upperPrice}`,
      description: `${s.levels} levels between ${s.lowerPrice} and ${s.upperPrice} ${priceSymbol}/USD.`,
      nodes,
      edges,
      steps: [
        "Check price every 5 minutes.",
        `Only act while ${priceSymbol}/USD is within ${s.lowerPrice}-${s.upperPrice}.`,
        buyDenominated
          ? `Acquire ${perLevel.toFixed(4)} ${s.buySymbol} per in-range run (spending at most the oracle-capped amount).`
          : `Place a grid buy of ${perLevel.toFixed(4)} ${s.sellSymbol} per in-range run.`,
      ],
    };
  }

  throw new Error(`Unsupported strategy kind: ${(s as { kind: string }).kind}`);
}
