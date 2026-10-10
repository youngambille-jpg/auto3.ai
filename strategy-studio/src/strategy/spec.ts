/**
 * Canonical strategy spec. The planner (deterministic or LLM-assisted) always
 * produces one of these, and the KeeperHub mapper consumes one. Keeping a single
 * narrow shape is the guardrail: the agent may only *propose*, and it can only
 * propose something in this union.
 */

export type StrategyKind = "twap" | "grid" | "limit" | "stop" | "dca";

export interface BaseStrategy {
  kind: StrategyKind;
  /** Human sentence the user typed. */
  prompt: string;
  /** Chain id as a decimal string, e.g. "42161". */
  chainId: string;
  /** Token the wallet spends (lowercased address). */
  sellToken: string;
  /** Token the wallet receives (lowercased address). */
  buyToken: string;
  sellSymbol: string;
  buySymbol: string;
  /** Uniswap V3 fee tier. */
  fee: string;
  /**
   * Total size in whole `sellToken` units. When `sizeUnit` is "buy" the size is
   * instead expressed in whole `buyToken` units (the amount to acquire).
   */
  totalSize: number;
  /**
   * Which leg `totalSize` is denominated in. "sell" = spend this much of the
   * sell token (default); "buy" = acquire this much of the buy token, using an
   * exact-output swap.
   */
  sizeUnit?: "sell" | "buy";
}

export interface TwapStrategy extends BaseStrategy {
  kind: "twap";
  /** Number of child orders. */
  slices: number;
  /** Minutes between slices. */
  intervalMinutes: number;
}

export interface DcaStrategy extends BaseStrategy {
  kind: "dca";
  slices: number;
  intervalMinutes: number;
}

export interface GridStrategy extends BaseStrategy {
  kind: "grid";
  lowerPrice: number;
  upperPrice: number;
  levels: number;
  /** Capital allocated across the grid, in whole sellToken units. */
  totalSize: number;
}

export interface LimitStrategy extends BaseStrategy {
  kind: "limit";
  side: "buy" | "sell";
  /** Trigger price in buyToken terms, e.g. USD per ETH. */
  limitPrice: number;
  /** Also restrict the swap to a minimum output (slippage guard). */
  amountOutMinimum?: string;
}

export interface StopStrategy extends BaseStrategy {
  kind: "stop";
  side: "buy" | "sell";
  stopPrice: number;
}

export type Strategy =
  | TwapStrategy
  | DcaStrategy
  | GridStrategy
  | LimitStrategy
  | StopStrategy;

export interface StrategyValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface Chains {
  /** Decimal chain ids the UI offers. */
  [chainId: string]: { name: string; explorer: string };
}
