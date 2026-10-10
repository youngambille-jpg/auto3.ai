/**
 * Token + chain registry. Addresses are the canonical Arbitrum ones used by
 * Uniswap V3. Symbols are matched case-insensitively in the planner.
 */

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export const CHAINS: Record<string, { name: string; explorer: string }> = {
  "42161": { name: "Arbitrum One", explorer: "https://arbiscan.io" },
  "421614": { name: "Arbitrum Sepolia", explorer: "https://sepolia.arbiscan.io" },
};

export const TOKENS: Record<string, TokenInfo[]> = {
  "42161": [
    { symbol: "ETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6 },
    { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 },
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18 },
    { symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18 },
  ],
  "421614": [
    { symbol: "ETH", address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", decimals: 18 },
    { symbol: "WETH", address: "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", decimals: 18 },
    { symbol: "USDC", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", decimals: 6 },
  ],
};

export function findToken(chainId: string, symbolOrAddress: string): TokenInfo | undefined {
  const list = TOKENS[chainId];
  if (!list) return undefined;
  const needle = symbolOrAddress.trim().toLowerCase();
  return list.find(
    (t) => t.symbol.toLowerCase() === needle || t.address.toLowerCase() === needle,
  );
}

/** Common fee tiers, used when the user does not specify one. */
export const DEFAULT_FEE = "500";
export const FEE_TIERS = ["100", "500", "3000", "10000"];
