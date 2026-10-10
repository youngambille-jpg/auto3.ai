/**
 * Assemble everything the preview card shows for a strategy: the compiled
 * steps, a backtest against recent candles, and live market context (Chainlink
 * price and a Uniswap quote with slippage). All optional pieces degrade to null
 * rather than failing the request.
 */

import { compileStrategy, type CompiledWorkflow } from "../strategy/compile.js";
import { backtest, type BacktestResult } from "../backtest/engine.js";
import { fetchCandles, riskySymbol } from "../backtest/candles.js";
import { keeperHub } from "../keeperhub/client.js";
import { findToken } from "../strategy/tokens.js";
import { decimalToRaw, rawToDecimal } from "../strategy/units.js";
import { usdFeedFor, rawToPrice, isStable } from "../strategy/prices.js";
import { validateStrategy } from "../strategy/planner.js";
import type { Strategy } from "../strategy/spec.js";

export interface Preview {
  steps: string[];
  workflow: { name: string; description: string; nodeCount: number; edges: unknown[] };
  backtest: BacktestResult | null;
  candlesSource: "binance" | "synthetic" | null;
  chainlinkPrice: number | null;
  quote: { amountOut: string; avgPrice: number; slippagePct: number | null } | null;
  registryQuote: { amountOut: string } | null;
  risks: string[];
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  walletAddress: string | null;
}

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

/** Slippage of the quote versus the oracle price, in percent, for either leg. */
function quoteSlippage(s: Strategy, quoteAvgPrice: number, oraclePrice: number | null): number | null {
  if (!oraclePrice || !quoteAvgPrice) return null;
  const sellIsRisky = !isStable(s.sellSymbol);
  // quoteAvgPrice is buy-token units per sell-token unit.
  // When selling the risky asset, the oracle says we should get oraclePrice (stable) per unit.
  // When buying the risky asset, the fair buy amount is 1/oraclePrice per stable unit.
  const fair = sellIsRisky ? oraclePrice : 1 / oraclePrice;
  if (fair <= 0) return null;
  return ((fair - quoteAvgPrice) / fair) * 100;
}

export async function buildPreview(s: Strategy, opts: { withMarket?: boolean } = {}): Promise<Preview> {
  const validation = validateStrategy(s);
  const risks: string[] = [...validation.warnings];

  // Resolve the wallet first: it doubles as the swap recipient and the custody note.
  const walletAddress = opts.withMarket === false
    ? null
    : await keeperHub.wallet().then((w) => w.find((i) => i.type === "web3")?.address ?? null).catch(() => null);

  let compiled: CompiledWorkflow | null = null;

  if (!walletAddress) {
    risks.push("No KeeperHub web3 wallet found; swaps have no recipient and cannot execute.");
  }
  if (s.chainId !== "42161") {
    risks.push("Execution is pinned to Arbitrum One: it is the only chain with both Uniswap V3 and the Chainlink feeds wired up.");
  }
  if (s.kind === "grid") {
    risks.push("Each grid fill is a separate onchain order, so this MVP fires one level per in-range check.");
  }
  if (s.kind === "twap" || s.kind === "dca") {
    risks.push("KeeperHub schedules run on cron, not per block; very fine slices are approximate.");
  }
  risks.push("Custody: execution runs from the organization's KeeperHub-managed wallet (full access), not a scoped session key.");

  const symbol = riskySymbol(s);
  const { candles, source } = await fetchCandles(s);
  let bt: BacktestResult | null = null;
  try {
    bt = backtest(s, candles);
  } catch {
    bt = null;
  }

  let chainlinkPrice: number | null = null;
  let quote: Preview["quote"] = null;
  let registryQuote: Preview["registryQuote"] = null;

  if (opts.withMarket !== false) {
    chainlinkPrice = await liveChainlinkPrice(symbol);
    // Prices for both legs let exact-output swaps cap their spend at the oracle.
    const [sellUsd, buyUsd] = await Promise.all([
      isStable(s.sellSymbol) ? 1 : liveChainlinkPrice(s.sellSymbol),
      isStable(s.buySymbol) ? 1 : liveChainlinkPrice(s.buySymbol),
    ]);
    try {
      compiled = compileStrategy(s, walletAddress ?? "", { sellUsd: sellUsd ?? undefined, buyUsd: buyUsd ?? undefined });
    } catch (e) {
      risks.push(`Not executable yet: ${(e as Error).message}`);
    }

    if (s.chainId === "42161") {
      const sellDecimals = findToken(s.chainId, s.sellToken)?.decimals ?? 18;
      const buyDecimals = findToken(s.chainId, s.buyToken)?.decimals ?? 18;
      // Buy-denominated sizes are quoted as the fair spend in the sell token.
      const amountIn =
        s.sizeUnit === "buy"
          ? decimalToRaw((chainlinkPrice ?? 1) * s.totalSize, sellDecimals)
          : decimalToRaw(s.totalSize, sellDecimals);
      try {
        const q = await keeperHub.protocolQuote("uniswap/quote-exact-input", {
          tokenIn: s.sellToken,
          tokenOut: s.buyToken,
          amountIn,
          fee: s.fee,
        });
        if (q?.result?.amountOut) {
          const out = Number(rawToDecimal(q.result.amountOut, buyDecimals));
          registryQuote = { amountOut: q.result.amountOut };
          const spent = Number(rawToDecimal(amountIn, sellDecimals));
          const avgPrice = spent > 0 ? out / spent : 0;
          quote = {
            amountOut: q.result.amountOut,
            avgPrice,
            slippagePct: quoteSlippage(s, avgPrice, chainlinkPrice),
          };
        }
      } catch {
        // no quote available; leave null
      }
    }
  }

  return {
    steps: compiled?.steps ?? [],
    workflow: compiled
      ? { name: compiled.name, description: compiled.description, nodeCount: compiled.nodes.length, edges: compiled.edges }
      : { name: "", description: "", nodeCount: 0, edges: [] },
    backtest: bt,
    candlesSource: source,
    chainlinkPrice,
    quote,
    registryQuote,
    risks: [...new Set(risks)],
    validation,
    walletAddress,
  };
}
