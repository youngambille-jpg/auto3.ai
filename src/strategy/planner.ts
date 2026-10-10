/**
 * Deterministic natural-language planner.
 *
 * This is the fallback when no LLM key is configured, and it is also what
 * validates and repairs LLM output. It is deliberately regex-based and boring:
 * the reliability of the whole product rests on the spec being correct.
 */

import { DEFAULT_CHAIN_ID } from "../config.js";
import { DEFAULT_FEE, findToken } from "./tokens.js";
import type { Strategy, StrategyKind, StrategyValidation } from "./spec.js";

const NUMBER = String.raw`(\d+(?:\.\d+)?)`;
const NUM = String.raw`\d+(?:\.\d+)?`;
const SYMBOLS = String.raw`eth|weth|usdc|usdt|arb|wbtc|dai|link`;

function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function firstMatch(re: RegExp, text: string): RegExpMatchArray | undefined {
  return re.exec(text) ?? undefined;
}

/** Pull an explicit chain out of the prompt, else use the configured default. */
export function detectChainId(prompt: string): string {
  const t = prompt.toLowerCase();
  if (/\barbitrum\s+sepolia\b/.test(t)) return "421614";
  if (/\barb(itrum)?\s*(one|mainnet)?\b/.test(t)) return "42161";
  return DEFAULT_CHAIN_ID;
}

const AMT = String.raw`(?:\d+(?:\.\d+)?\s*)?`;

/** Detect "<n> <SYM>" style token mentions, both orders. */
export function detectTokenPair(
  prompt: string,
  chainId: string,
): { sellToken: string; buyToken: string; sellSymbol: string; buySymbol: string } | undefined {
  const t = prompt;
  const symbols = ["eth", "weth", "usdc", "usdt", "arb", "wbtc", "dai", "link"];

  // "buy ETH with USDC", "accumulate ETH using USDC"
  const buyFor = new RegExp(
    `(?:buy|accumulate|long)\\s+${AMT}\\$?(\\w+)\\s+(?:with|using|for|against)\\s+${AMT}\\$?(\\w+)`,
    "i",
  ).exec(t);
  if (buyFor) {
    const buy = findToken(chainId, buyFor[1]!);
    const sell = findToken(chainId, buyFor[2]!);
    if (buy && sell) return pair(sell, buy);
  }

  // "sell ETH for USDC", "sell ETH to USDC"
  const sellFor = new RegExp(
    `(?:sell|dump|exit|close)\\s+${AMT}\\$?(\\w+)\\s+(?:for|to|into|and\\s+buy)\\s+${AMT}\\$?(\\w+)`,
    "i",
  ).exec(t);
  if (sellFor) {
    const sell = findToken(chainId, sellFor[1]!);
    const buy = findToken(chainId, sellFor[2]!);
    if (sell && buy) return pair(sell, buy);
  }

  const swapTo = new RegExp(
    `(?:swap|convert|trade)\\s+${AMT}\\$?(\\w+)\\s+(?:to|into|for)\\s+${AMT}\\$?(\\w+)`,
    "i",
  ).exec(t);
  if (swapTo) {
    const sell = findToken(chainId, swapTo[1]!);
    const buy = findToken(chainId, swapTo[2]!);
    if (sell && buy) return pair(sell, buy);
  }

  // "grid for ARB ... using 500 USDC", "DCA into ETH with USDC": the "for/into"
  // token is the target asset (buy), the "using/with/spend" token is the budget (sell).
  const forTarget = new RegExp(`(?:for|into|on)\\s+${AMT}\\$?(\\w+)`, "i").exec(t);
  const usingSource = new RegExp(
    `(?:using|with|spend|spending|budget\\s+of|from)\\s+${AMT}\\$?(\\w+)`,
    "i",
  ).exec(t);
  if (forTarget && usingSource) {
    const buy = findToken(chainId, forTarget[1]!);
    const sell = findToken(chainId, usingSource[1]!);
    if (buy && sell && buy.symbol !== sell.symbol) return pair(sell, buy);
  }

  // Fallback: any two symbols present, first = sell, second = buy.
  const found: { sym: string; idx: number }[] = [];
  for (const s of symbols) {
    const m = new RegExp(`\\b${s}\\b`, "i").exec(t);
    if (m) found.push({ sym: s, idx: m.index });
  }
  found.sort((a, b) => a.idx - b.idx);
  const present = found.map((f) => findToken(chainId, f.sym)).filter(Boolean) as { symbol: string; address: string }[];
  if (present.length >= 2) {
    // A directional verb that names a token fixes that leg explicitly, so the
    // other present token becomes the counterparty.
    const verb = /(buy|accumulate|long|acquire|sell|dump|exit|close)\s+(?:\d+(?:\.\d+)?\s*)?\$?(\w+)/i.exec(t);
    if (verb) {
      const named = findToken(chainId, verb[2]!);
      const other = named && present.find((p) => p.symbol !== named.symbol);
      if (named && other) {
        return /buy|accumulate|long|acquire/i.test(verb[1]!) ? pair(other, named) : pair(named, other);
      }
    }
    return pair(present[0]!, present[1]!);
  }

  // Single risky asset mentioned: infer the quote leg from a default stablecoin.
  if (present.length === 1) {
    const only = present[0]!;
    const stable = findToken(chainId, "USDC") ?? findToken(chainId, "USDT") ?? findToken(chainId, "DAI");
    if (stable && stable.symbol !== only.symbol) {
      if (/\b(sell|dump|exit|close)\b/i.test(t)) return pair(only, stable);
      return pair(stable, only);
    }
  }
  return undefined;
}

function pair(
  sell: { symbol: string; address: string },
  buy: { symbol: string; address: string },
): { sellToken: string; buyToken: string; sellSymbol: string; buySymbol: string } {
  return {
    sellToken: sell.address.toLowerCase(),
    buyToken: buy.address.toLowerCase(),
    sellSymbol: sell.symbol,
    buySymbol: buy.symbol,
  };
}

export function detectSize(prompt: string): number | undefined {
  // "5 ETH", "1000 USDC", "0.5 eth"
  const m = new RegExp(`${NUMBER}\\s*(?:\\$)?(eth|weth|usdc|usdt|arb|wbtc|dai|link)\\b`, "i").exec(prompt);
  if (m) return toNumber(m[1]);
  // "spend 1000 usdc", "size 2 eth"
  const s = new RegExp(`(?:size|amount|spend|buy|sell|swap|convert)\\s+${NUMBER}`, "i").exec(prompt);
  return toNumber(s?.[1]);
}

/**
 * True when the size is stated in the asset being acquired ("buy 2 ETH") rather
 * than the cash being spent ("spend 100 USDC"). Used to pick an exact-output swap
 * so "2 ETH" really means 2 ETH and not 2 USDC. A dollar sign forces a spend.
 */
export function sizeIsBuyDenominated(prompt: string, buySymbol: string): boolean {
  const m = new RegExp(`(${NUM})\\s*\\$?(${SYMBOLS})\\b`, "i").exec(prompt);
  if (m) {
    // The size names a token. It is buy-denominated only if that token is the
    // one being acquired, and not a dollar spend ("$2 ETH").
    if (m[2]!.toUpperCase() !== buySymbol.toUpperCase()) return false;
    return !/\$\s*$/.test(prompt.slice(0, m.index));
  }
  // A bare number is buy-denominated only alongside a buy verb and no cash cue.
  return /\b(?:buy|accumulate|long|acquire)\b/i.test(prompt) && !/\$|\bspend\b|\bsell\b/i.test(prompt);
}

export function detectKind(prompt: string): StrategyKind {
  const t = prompt.toLowerCase();
  if (/\btwap\b|over\s+\d+\s*(hour|h|minute|min|day)/.test(t)) return "twap";
  if (/\bgrid\b/.test(t)) return "grid";
  if (/\bstop[-\s]?loss\b|\bstop\b/.test(t)) return "stop";
  if (/\blimit\b/.test(t)) return "limit";
  if (/\bdca\b|daily|weekly|every\s+day|recurring/.test(t)) return "dca";
  return "twap";
}

function detectDurationMinutes(prompt: string): number | undefined {
  const t = prompt.toLowerCase();
  const h = /(?:over|within|in|across)\s+(\d+(?:\.\d+)?)\s*(?:hours?|h)\b/.exec(t);
  if (h) return toNumber(h[1])! * 60;
  const m = /(?:over|within|in|across)\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/.exec(t);
  if (m) return toNumber(m[1]);
  const d = /(?:over|within|in|across)\s+(\d+(?:\.\d+)?)\s*(?:days?|d)\b/.exec(t);
  if (d) return toNumber(d[1])! * 60 * 24;
  return undefined;
}

function detectSlices(prompt: string): number | undefined {
  const m = /(\d+)\s+(?:slices?|steps?|orders?|chunks?|tranches?|times)/i.exec(prompt);
  return m ? toNumber(m[1]) : undefined;
}

function detectLevels(prompt: string): number | undefined {
  const m = /(\d+)\s+(?:levels?|grids?|lines?|rungs?)/i.exec(prompt);
  return m ? toNumber(m[1]) : undefined;
}

function detectLevelsOrSlicesForGrid(prompt: string): number | undefined {
  return detectLevels(prompt) ?? detectSlices(prompt);
}

/** "between 2400 and 2800", "from $2400 to $2800" */
function detectRange(prompt: string): { low: number; high: number } | undefined {
  const m = new RegExp(
    `(?:between|from|within)\\s*\\$?${NUMBER}\\s*(?:and|to|-|–)\\s*\\$?${NUMBER}`,
    "i",
  ).exec(prompt);
  if (!m) return undefined;
  const a = toNumber(m[1])!;
  const b = toNumber(m[2])!;
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

function detectSinglePrice(prompt: string, keyword: string): number | undefined {
  const m = new RegExp(`${keyword}\\s*(?:at|price\\s*(?:of|is)?)?\\s*\\$?${NUMBER}`, "i").exec(prompt);
  if (m) return toNumber(m[2]);
  const p = new RegExp(
    `(?:at|above|below|when|to|reaches?|hits?|rises?\\s+to|drops?\\s+to|falls?\\s+to)\\s*\\$?${NUMBER}`,
    "i",
  ).exec(prompt);
  return toNumber(p?.[1]);
}

export function detectFee(prompt: string): string {
  const m = /(\d+)\s*bps|fee\s*(?:tier|of)?\s*(100|500|3000|10000)/i.exec(prompt);
  if (m) {
    const v = m[1]!;
    if (["100", "500", "3000", "10000"].includes(v)) return v;
  }
  return DEFAULT_FEE;
}

const USDC_LIKE = new Set(["usdc", "usdt", "dai"]);

/**
 * Turn free text into a validated strategy. Returns the strategy plus a list of
 * assumptions the planner made, so the UI can show them on the preview card.
 */
export function planFromText(prompt: string): {
  strategy?: Strategy;
  assumptions: string[];
  error?: string;
} {
  const text = prompt.trim();
  if (!text) return { assumptions: [], error: "Describe the strategy you want." };

  const chainId = detectChainId(text);
  const pairInfo = detectTokenPair(text, chainId);
  if (!pairInfo) {
    return {
      assumptions: [],
      error:
        "Could not tell which tokens to trade. Try e.g. \"TWAP buy 5 ETH with USDC over 6 hours\".",
    };
  }

  const kind = detectKind(text);
  const fee = detectFee(text);
  const sizeUnit: "sell" | "buy" = sizeIsBuyDenominated(text, pairInfo.buySymbol) ? "buy" : "sell";
  const assumptions: string[] = [`Interpreted as a ${kind.toUpperCase()} on chain ${chainId}.`];
  if (sizeUnit === "buy") {
    assumptions.push("Sizing is in the acquired asset, so the swap uses an exact-output order with an oracle-capped spend.");
  }

  const base = {
    prompt: text,
    chainId,
    fee,
    sizeUnit,
    ...pairInfo,
  };

  if (kind === "grid") {
    const range = detectRange(text);
    if (!range) {
      return {
        assumptions,
        error: "Grid needs a price range, e.g. \"grid ETH between 2400 and 2800 with 10 levels\".",
      };
    }
    const levels = detectLevelsOrSlicesForGrid(text) ?? 10;
    const totalSize = detectSize(text) ?? 1;
    const unitSymbol = sizeUnit === "buy" ? pairInfo.buySymbol : pairInfo.sellSymbol;
    assumptions.push(`Assumed ${totalSize} ${unitSymbol} of capital across ${levels} levels.`);
    return {
      assumptions,
      strategy: { ...base, kind, lowerPrice: range.low, upperPrice: range.high, levels, totalSize },
    };
  }

  if (kind === "limit" || kind === "stop") {
    const side: "buy" | "sell" = /\b(sell|exit)\b/i.test(text) ? "sell" : "buy";
    const price =
      detectSinglePrice(text, kind === "limit" ? "limit" : "stop") ?? detectSinglePrice(text, "at");
    if (price === undefined) {
      return {
        assumptions,
        error: `${kind} needs a trigger price, e.g. "${kind} buy ETH at 2400".`,
      };
    }
    const totalSize = detectSize(text) ?? 1;
    assumptions.push(`Assumed trigger price ${price} ${pairInfo.buySymbol}.`);
    if (kind === "limit") {
      return { assumptions, strategy: { ...base, kind, side, limitPrice: price, totalSize } };
    }
    return { assumptions, strategy: { ...base, kind, side, stopPrice: price, totalSize } };
  }

  // twap / dca
  const totalSize = detectSize(text) ?? 1;
  const duration = detectDurationMinutes(text);
  let slices = detectSlices(text);
  let intervalMinutes: number;

  if (duration !== undefined) {
    const defaultSlices = kind === "dca" ? undefined : 6;
    slices = slices ?? defaultSlices ?? Math.max(2, Math.round(duration / (24 * 60)));
    intervalMinutes = Math.max(1, Math.round(duration / slices));
    assumptions.push(
      `Assumed ${slices} slices spaced ${intervalMinutes} minutes apart to cover ${duration} minutes.`,
    );
  } else if (kind === "dca") {
    slices = slices ?? 30;
    intervalMinutes = 24 * 60;
    assumptions.push(`No duration given, defaulted to a daily DCA over ${slices} days.`);
  } else {
    slices = slices ?? 6;
    intervalMinutes = 60;
    assumptions.push(`No duration given, defaulted to ${slices} hourly slices.`);
  }

  if (totalSize === 1 && !detectSize(text)) {
    assumptions.push(`No size given, defaulted to 1 ${pairInfo.sellSymbol}.`);
  }

  return { assumptions, strategy: { ...base, kind, slices, intervalMinutes, totalSize } };
}

/** Structural validation, applied to both deterministic and LLM-produced specs. */
export function validateStrategy(s: Partial<Strategy> | undefined): StrategyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!s) return { ok: false, errors: ["No strategy produced."], warnings };

  const chainId = (s as { chainId?: string }).chainId;
  if (!chainId || !["42161", "421614"].includes(chainId)) {
    errors.push("Chain must be Arbitrum One (42161) or Arbitrum Sepolia (421614).");
  }
  if (chainId === "42161") {
    warnings.push("Targeting Arbitrum One mainnet. This moves real funds.");
  }
  const sell = (s as { sellToken?: string }).sellToken;
  const buy = (s as { buyToken?: string }).buyToken;
  if (!sell || !/^0x[0-9a-f]{40}$/.test(sell)) errors.push("sellToken must be a 0x address.");
  if (!buy || !/^0x[0-9a-f]{40}$/.test(buy)) errors.push("buyToken must be a 0x address.");
  if (sell && buy && sell === buy) errors.push("sellToken and buyToken must differ.");

  const size = (s as { totalSize?: number }).totalSize;
  if (typeof size !== "number" || !(size > 0)) errors.push("totalSize must be a positive number.");

  const sizeUnit = (s as { sizeUnit?: string }).sizeUnit;
  if (sizeUnit !== undefined && sizeUnit !== "sell" && sizeUnit !== "buy") {
    errors.push("sizeUnit must be 'sell' or 'buy'.");
  }

  switch ((s as { kind?: string }).kind) {
    case "twap":
    case "dca": {
      const slices = (s as { slices?: number }).slices;
      const interval = (s as { intervalMinutes?: number }).intervalMinutes;
      if (!Number.isInteger(slices) || (slices ?? 0) < 2) errors.push("slices must be an integer >= 2.");
      if (!Number.isInteger(interval) || (interval ?? 0) < 1) errors.push("intervalMinutes must be >= 1.");
      if (interval !== undefined && interval < 5 && (slices ?? 0) > 12) {
        warnings.push("Very fine slices: KeeperHub Cron evaluates on a schedule, not per block.");
      }
      break;
    }
    case "grid": {
      const lo = (s as { lowerPrice?: number }).lowerPrice;
      const hi = (s as { upperPrice?: number }).upperPrice;
      const levels = (s as { levels?: number }).levels;
      if (typeof lo !== "number" || typeof hi !== "number" || !(hi > lo)) {
        errors.push("Grid needs upperPrice > lowerPrice.");
      }
      if (!Number.isInteger(levels) || (levels ?? 0) < 2) errors.push("levels must be an integer >= 2.");
      if ((levels ?? 0) > 50) warnings.push("Many grid levels: each fill is a separate onchain order.");
      break;
    }
    case "limit":
    case "stop": {
      const side = (s as { side?: string }).side;
      if (side !== "buy" && side !== "sell") errors.push("side must be 'buy' or 'sell'.");
      const price = (s as { limitPrice?: number; stopPrice?: number }).limitPrice ??
        (s as { stopPrice?: number }).stopPrice;
      if (typeof price !== "number" || !(price > 0)) errors.push("A positive trigger price is required.");
      break;
    }
    default:
      errors.push(`Unsupported strategy kind: ${String((s as { kind?: string }).kind)}`);
  }

  // Stablecoin pair sanity: a "buy X with USDC" must not have USDC as both legs.
  if (sell && buy && USDC_LIKE.has(String(sell)) && USDC_LIKE.has(String(buy))) {
    warnings.push("Both legs look like stablecoins.");
  }

  return { ok: errors.length === 0, errors, warnings };
}
