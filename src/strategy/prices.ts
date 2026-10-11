/**
 * Chainlink USD price feeds on Arbitrum One. Only feeds that are verified on
 * the explorer are listed, because read-contract auto-fetches the ABI.
 * All feeds answer latestAnswer() as an int256 with 8 decimals.
 */

export interface PriceFeed {
  key: string;
  symbol: string;
  address: string;
  decimals: number;
}

export const CHAINLINK_FEEDS: Record<string, PriceFeed> = {
  ETH: { key: "ETH", symbol: "ETH/USD", address: "0x639fe6ab55c921f74e7fac1ee960c0b6293ba612", decimals: 8 },
  WETH: { key: "ETH", symbol: "ETH/USD", address: "0x639fe6ab55c921f74e7fac1ee960c0b6293ba612", decimals: 8 },
  BTC: { key: "BTC", symbol: "BTC/USD", address: "0x6ce185860a4963106506c203335a2910413708e9", decimals: 8 },
  WBTC: { key: "BTC", symbol: "BTC/USD", address: "0x6ce185860a4963106506c203335a2910413708e9", decimals: 8 },
  USDC: { key: "USDC", symbol: "USDC/USD", address: "0x50834f3163758fcc1df9973b6e91f0f0f0434ad3", decimals: 8 },
  DAI: { key: "DAI", symbol: "DAI/USD", address: "0xc5c8e77b397e531b8ec06bfb0048328b30e9ecfb", decimals: 8 },
  LINK: { key: "LINK", symbol: "LINK/USD", address: "0x86e53cf1b870786351da77a57575e79cb55812cb", decimals: 8 },
  ARB: { key: "ARB", symbol: "ARB/USD", address: "0xb2a824043730fe05f3da2efafa1cbbe83fa548d6", decimals: 8 },
};

/** The USD feed that prices `symbol`, following the buy leg toward USD. */
export function usdFeedFor(symbol: string): PriceFeed | undefined {
  return CHAINLINK_FEEDS[symbol.toUpperCase()];
}

/**
 * KeeperHub native Chainlink read actions, keyed by symbol. These avoid
 * hand-rolling an ABI and a contract address in the workflow, and return a
 * structured `result.answer`. Symbols with no native action fall back to a
 * generic `web3/read-contract` over `CHAINLINK_FEEDS`.
 */
const NATIVE_FEED_ACTIONS: Record<string, string> = {
  ETH: "chainlink/eth-usd-latest-round-data",
  WETH: "chainlink/eth-usd-latest-round-data",
  BTC: "chainlink/btc-usd-latest-round-data",
  WBTC: "chainlink/btc-usd-latest-round-data",
  LINK: "chainlink/link-usd-latest-round-data",
  USDC: "chainlink/usdc-usd-latest-round-data",
  DAI: "chainlink/dai-usd-latest-round-data",
  USDT: "chainlink/usdt-usd-latest-round-data",
};

export function nativeFeedAction(symbol: string): string | undefined {
  return NATIVE_FEED_ACTIONS[symbol.toUpperCase()];
}

export const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);

/**
 * Minimal Chainlink AggregatorV3 ABI. Workflow read-contract nodes need the ABI
 * supplied explicitly (the auto-fetch used by direct execution does not apply to
 * workflow nodes), and latestAnswer() is all the price reads need.
 */
export const CHAINLINK_ABI = JSON.stringify([
  {
    inputs: [],
    name: "latestAnswer",
    outputs: [{ internalType: "int256", name: "", type: "int256" }],
    stateMutability: "view",
    type: "function",
  },
]);

export function isStable(symbol: string): boolean {
  return STABLE_SYMBOLS.has(symbol.toUpperCase());
}

/** Human price from a raw Chainlink int256 answer. */
export function rawToPrice(raw: string, decimals = 8): number {
  return Number(raw) / 10 ** decimals;
}
