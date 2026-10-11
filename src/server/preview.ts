/**
 * Assemble everything the preview card shows for a strategy: the compiled
 * steps, a backtest against recent candles, and live market context (Chainlink
 * price and a Uniswap quote with slippage). All optional pieces degrade to null
 * rather than failing the request.
 */

import { backtest, type BacktestResult } from "../backtest/engine.js";
import { fetchCandles, riskySymbol } from "../backtest/candles.js";
import { keeperHub } from "../keeperhub/client.js";
import { keeperHubMcp } from "../keeperhub/mcp.js";
import { findToken } from "../strategy/tokens.js";
import { decimalToRaw, rawToDecimal } from "../strategy/units.js";
import { isStable } from "../strategy/prices.js";
import { validateStrategy } from "../strategy/planner.js";
import { compileWithContext, liveChainlinkPrice, resolveMarketContext, type MarketContext } from "./context.js";
import type { CompiledWorkflow } from "../strategy/compile.js";
import type { Strategy } from "../strategy/spec.js";

export { liveChainlinkPrice };

export interface Preview {
  steps: string[];
  workflow: { name: string; description: string; nodeCount: number; edges: unknown[] };
  backtest: BacktestResult | null;
  candlesSource: "binance" | "synthetic" | null;
  chainlinkPrice: number | null;
  quote: { amountOut: string; avgPrice: number; slippagePct: number | null } | null;
  registryQuote: { amountOut: string } | null;
  /** Buy-denominated: the real sell-token spend for the whole strategy, from a live exact-output quote. */
  budget: { amountIn: string; amount: number } | null;
  risks: string[];
  validation: { ok: boolean; errors: string[]; warnings: string[] };
  walletAddress: string | null;
  /** KeeperHub-side validation of the compiled workflow, when we could run it. */
  keeperHubValidation: { ok: boolean; checked: boolean; warnings: string[] } | null;
}

/**
 * KeeperHub has no validate-before-create, so a compiled workflow is created
 * disabled, validated, and deleted. Returns KeeperHub's warnings; `checked`
 * is false when the call could not run (so the caller can tell "clean" from
 * "unknown").
 */
export async function validateCompiled(
  compiled: CompiledWorkflow,
): Promise<{ ok: boolean; checked: boolean; warnings: string[] }> {
  let id: string | undefined;
  try {
    const created = await keeperHub.createWorkflow({
      name: `__validate__ ${compiled.name}`.slice(0, 80),
      description: compiled.description,
      nodes: compiled.nodes,
      edges: compiled.edges,
      enabled: false,
    });
    id = created?.id;
    if (!id) return { ok: false, checked: false, warnings: [] };
    const v = await keeperHubMcp.validateWorkflow(id);
    const warnings = (v.warnings ?? [])
      .map((w) => (w.code ? `${w.code}: ${w.message ?? ""}`.trim() : w.message ?? ""))
      .filter(Boolean);
    const errors = (v.errors ?? [])
      .map((e) => (e.code ? `${e.code}: ${e.message ?? ""}`.trim() : e.message ?? ""))
      .filter(Boolean);
    return { ok: v.valid && errors.length === 0, checked: true, warnings: [...errors, ...warnings] };
  } catch {
    return { ok: false, checked: false, warnings: [] };
  } finally {
    if (id) await keeperHub.deleteWorkflow(id).catch(() => undefined);
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

export async function buildPreview(
  s: Strategy,
  opts: { withMarket?: boolean; withKeeperHubValidation?: boolean } = {},
): Promise<Preview> {
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
  let budget: Preview["budget"] = null;
  let keeperHubValidation: Preview["keeperHubValidation"] = null;
  let ctx: MarketContext | null = null;

  if (opts.withMarket !== false) {
    // One resolution of wallet + prices + budget, shared with execute.
    ctx = await resolveMarketContext(s);
    chainlinkPrice = ctx.riskyPrice;
    budget = ctx.budget;

    try {
      compiled = compileWithContext(s, ctx);
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

    // Ask KeeperHub to validate the compiled graph. Ternary-gated off by
    // default; it costs a create + delete round trip.
    if (compiled && opts.withKeeperHubValidation) {
      keeperHubValidation = await validateCompiled(compiled);
      if (keeperHubValidation.checked && keeperHubValidation.warnings.length) {
        risks.push(`KeeperHub validation: ${keeperHubValidation.warnings.join("; ")}`);
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
    budget,
    risks: [...new Set(risks)],
    validation,
    walletAddress,
    keeperHubValidation,
  };
}
