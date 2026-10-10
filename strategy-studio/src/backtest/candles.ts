/**
 * Candle source for the preview. Tries Binance's public klines endpoint for a
 * realistic recent series, and falls back to a deterministic synthetic series so
 * the preview always renders (offline, rate-limited, or unknown symbol).
 */

import type { Candle } from "./engine.js";
import { isStable } from "../strategy/prices.js";
import type { Strategy } from "../strategy/spec.js";

const BINANCE: Record<string, string> = {
  ETH: "ETHUSDT",
  WETH: "ETHUSDT",
  BTC: "BTCUSDT",
  WBTC: "BTCUSDT",
  ARB: "ARBUSDT",
  LINK: "LINKUSDT",
  DAI: "DAIUSDT",
};

/** The risky leg whose USD price drives the preview. */
export function riskySymbol(s: Pick<Strategy, "sellSymbol" | "buySymbol">): string {
  return isStable(s.sellSymbol) ? s.buySymbol.toUpperCase() : s.sellSymbol.toUpperCase();
}

export async function fetchCandles(
  s: Pick<Strategy, "sellSymbol" | "buySymbol">,
  interval = "1h",
  limit = 200,
): Promise<{ candles: Candle[]; source: "binance" | "synthetic" }> {
  const sym = riskySymbol(s);
  const pair = BINANCE[sym];
  if (pair) {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const rows = (await res.json()) as unknown[][];
        const candles = rows.map((r) => ({
          t: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
        }));
        if (candles.length > 2) return { candles, source: "binance" };
      }
    } catch {
      // fall through to synthetic
    }
  }
  return { candles: syntheticCandles(limit, seedFrom(sym)), source: "synthetic" };
}

function seedFrom(sym: string): number {
  let h = 2166136261;
  for (const ch of sym) h = (h ^ ch.charCodeAt(0)) * 16777619;
  return Math.abs(h);
}

/** Deterministic geometric random walk; same symbol always yields same series. */
export function syntheticCandles(limit: number, seed: number, start = 2500): Candle[] {
  let s = seed || 1;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const now = Date.now();
  const stepMs = 3_600_000;
  let price = start;
  const out: Candle[] = [];
  for (let i = limit - 1; i >= 0; i--) {
    const drift = (rand() - 0.5) * 0.03;
    const open = price;
    const close = Math.max(1, open * (1 + drift));
    const high = Math.max(open, close) * (1 + rand() * 0.008);
    const low = Math.min(open, close) * (1 - rand() * 0.008);
    out.push({ t: now - i * stepMs, open, high, low, close });
    price = close;
  }
  return out;
}
