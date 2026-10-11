/**
 * One place to resolve everything a strategy needs from the outside world: the
 * KeeperHub wallet, live Chainlink USD prices for both legs, and — for
 * buy-denominated sizes — a real Uniswap `quote-exact-output` budget. Preview
 * and execute share this so the card the user approves is exactly what runs.
 */

import { compileStrategy, type CompiledWorkflow } from "../strategy/compile.js";
import { keeperHub } from "../keeperhub/client.js";
import { riskySymbol } from "../backtest/candles.js";
import { findToken } from "../strategy/tokens.js";
import { decimalToRaw, rawToDecimal } from "../strategy/units.js";
import { usdFeedFor, rawToPrice, isStable } from "../strategy/prices.js";
import type { Strategy } from "../strategy/spec.js";

export async function liveChainlinkPrice(symbol: string): Promise<number | null> {
  const feed = usdFeedFor(symbol);
  if (!feed) return null;
  try {
    const res = await fetch(`${process.env.KEEPERHUB_BASE_URL ?? "https://app.keeperhub.com"}/api/execute/contract-call`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.KEEPERHUB_API_KEY ?? ""}`,
        "Content-Type": "application/json",
        "User-Agent": "strategy-studio/0.1",
      },
      body: JSON.stringify({ chainId: "42161", contractAddress: feed.address, functionName: "latestAnswer" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const out = (await res.json()) as { result?: string };
    return out?.result ? rawToPrice(out.result, feed.decimals) : null;
  } catch {
    return null;
  }
}

export interface MarketContext {
  walletAddress: string | null;
  /** Oracle price of the strategy's risky leg. */
  riskyPrice: number | null;
  sellUsd: number | null;
  buyUsd: number | null;
  /** Sell-token budget for one swap unit, from a live exact-output quote. */
  swapBudget?: number;
  /** Whole-strategy sell-token spend, for display. */
  budget: { amountIn: string; amount: number } | null;
}

/** The per-swap unit size for a buy-denominated strategy. */
function perSwapUnit(s: Strategy): number {
  if (s.kind === "twap" || s.kind === "dca") return s.totalSize / s.slices;
  if (s.kind === "grid") return s.totalSize / s.levels;
  return s.totalSize;
}

function swapCount(s: Strategy): number {
  if (s.kind === "twap" || s.kind === "dca") return s.slices;
  if (s.kind === "grid") return s.levels;
  return 1;
}

export async function resolveMarketContext(s: Strategy): Promise<MarketContext> {
  const walletAddress = await keeperHub
    .wallet()
    .then((w) => w.find((i) => i.type === "web3")?.address ?? null)
    .catch(() => null);

  const riskyPrice = await liveChainlinkPrice(riskySymbol(s));

  const sellDecimals = findToken(s.chainId, s.sellToken)?.decimals ?? 18;
  const buyDecimals = findToken(s.chainId, s.buyToken)?.decimals ?? 18;

  let swapBudget: number | undefined;
  let budget: MarketContext["budget"] = null;
  if (s.sizeUnit === "buy" && s.chainId === "42161") {
    try {
      const q = await keeperHub.protocolQuote("uniswap/quote-exact-output", {
        tokenIn: s.sellToken,
        tokenOut: s.buyToken,
        amount: decimalToRaw(perSwapUnit(s), buyDecimals),
        fee: s.fee,
      });
      if (q?.result?.amountIn) {
        const per = Number(rawToDecimal(q.result.amountIn, sellDecimals));
        swapBudget = per;
        budget = { amountIn: q.result.amountIn, amount: per * swapCount(s) };
      }
    } catch {
      // no live budget; the oracle cap stands in
    }
  }

  const [sellUsd, buyUsd] = await Promise.all([
    isStable(s.sellSymbol) ? Promise.resolve(1) : liveChainlinkPrice(s.sellSymbol),
    isStable(s.buySymbol) ? Promise.resolve(1) : liveChainlinkPrice(s.buySymbol),
  ]);

  return {
    walletAddress,
    riskyPrice,
    sellUsd,
    buyUsd,
    swapBudget,
    budget,
  };
}

/** Compile a strategy using a resolved market context. */
export function compileWithContext(s: Strategy, ctx: MarketContext): CompiledWorkflow {
  return compileStrategy(s, ctx.walletAddress ?? "", {
    sellUsd: ctx.sellUsd ?? undefined,
    buyUsd: ctx.buyUsd ?? undefined,
    swapBudget: ctx.swapBudget,
  });
}
