/**
 * The market surface the composer can check before it plans. Pairs come from
 * our token registry (canonical Arbitrum addresses) and the action list comes
 * from KeeperHub's own `list_action_schemas`, so the UI can tell the user which
 * Uniswap actions exist rather than guessing. A live quote probe answers
 * "does this pool actually exist?".
 */

import { TOKENS, CHAINS, FEE_TIERS, findToken } from "../strategy/tokens.js";
import { keeperHub } from "../keeperhub/client.js";
import { keeperHubMcp } from "../keeperhub/mcp.js";
import { decimalToRaw, rawToDecimal } from "../strategy/units.js";
import { isStable } from "../strategy/prices.js";

export interface MarketToken {
  symbol: string;
  address: string;
  decimals: number;
}

export interface Markets {
  chainId: string;
  chains: { id: string; name: string; explorer: string }[];
  tokens: MarketToken[];
  feeTiers: string[];
  /** Uniswap actionTypes KeeperHub exposes, filtered from list_action_schemas. */
  uniswapActions: string[];
  /** Stable symbols we treat as cash (USD ~ 1) when quoting. */
  stableSymbols: string[];
}

let schemaCache: { at: number; actions: string[] } | null = null;

async function uniswapActions(): Promise<string[]> {
  if (schemaCache && Date.now() - schemaCache.at < 5 * 60_000) return schemaCache.actions;
  try {
    const out = (await keeperHubMcp.listActionSchemas()) as { actions?: Record<string, unknown> };
    const actions = Object.keys(out?.actions ?? {})
      .filter((a) => a.startsWith("uniswap/"))
      .sort();
    schemaCache = { at: Date.now(), actions };
    return actions;
  } catch {
    return schemaCache?.actions ?? [];
  }
}

export async function getMarkets(chainId = "42161"): Promise<Markets> {
  const tokens = (TOKENS[chainId] ?? [])
    // ETH and WETH share an address; collapse to one row per address.
    .filter((t, i, arr) => arr.findIndex((x) => x.address.toLowerCase() === t.address.toLowerCase()) === i)
    .map((t) => ({ symbol: t.symbol, address: t.address, decimals: t.decimals }));
  return {
    chainId,
    chains: Object.entries(CHAINS).map(([id, c]) => ({ id, name: c.name, explorer: c.explorer })),
    tokens,
    feeTiers: FEE_TIERS,
    uniswapActions: await uniswapActions(),
    stableSymbols: [...new Set(tokens.filter((t) => isStable(t.symbol)).map((t) => t.symbol))],
  };
}

export interface PairProbe {
  ok: boolean;
  reason?: string;
  amountOut?: string;
  avgPrice?: number;
}

/**
 * Probe a pair with a unit-sized exact-input quote so the composer can reject a
 * pair with no pool before planning.
 */
export async function probePair(
  chainId: string,
  tokenIn: string,
  tokenOut: string,
  fee = "500",
): Promise<PairProbe> {
  const inTok = findToken(chainId, tokenIn);
  const outTok = findToken(chainId, tokenOut);
  if (!inTok || !outTok) return { ok: false, reason: "unknown token" };
  if (inTok.address.toLowerCase() === outTok.address.toLowerCase()) {
    return { ok: false, reason: "tokenIn and tokenOut are the same" };
  }
  try {
    const amountIn = decimalToRaw(isStable(inTok.symbol) ? 1 : 0.001, inTok.decimals);
    const q = await keeperHub.protocolQuote("uniswap/quote-exact-input", {
      tokenIn: inTok.address,
      tokenOut: outTok.address,
      amountIn,
      fee,
    });
    const out = q?.result?.amountOut;
    if (!out || out === "0") return { ok: false, reason: "no pool or no liquidity at this fee tier" };
    const spent = Number(rawToDecimal(amountIn, inTok.decimals));
    const got = Number(rawToDecimal(out, outTok.decimals));
    return { ok: true, amountOut: out, avgPrice: spent > 0 ? got / spent : undefined };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
