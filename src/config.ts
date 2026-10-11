/** Server-side configuration. All values have safe defaults. */

export const DEFAULT_CHAIN_ID = process.env.STRATEGY_CHAIN_ID ?? "42161";

export const PORT = Number(process.env.PORT ?? 8787);

export const KEEPERHUB_BASE_URL =
  process.env.KEEPERHUB_BASE_URL ?? "https://app.keeperhub.com";

/** Read at call time so tests can set it after import. */
export function keeperHubKey(): string {
  return process.env.KEEPERHUB_API_KEY ?? "";
}

export type LlmProvider = "gemini" | "openrouter" | "openai";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Per-request timeout; a slow provider should not block the chain. */
  timeoutMs: number;
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1";

function timeoutMs(): number {
  // Reasoning models can take 10s+ to emit a full strategy, so the default is
  // generous; a provider that is merely slow still gets skipped by the chain.
  const n = Number(process.env.LLM_TIMEOUT_MS ?? "45000");
  return Number.isFinite(n) && n > 0 ? n : 45_000;
}

function geminiConfig(): LlmConfig | undefined {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) return undefined;
  return {
    provider: "gemini",
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-flash-latest",
    timeoutMs: timeoutMs(),
  };
}

function openRouterConfig(): LlmConfig | undefined {
  const apiKey = process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) return undefined;
  return {
    provider: "openrouter",
    apiKey,
    // A concrete default keeps the chain usable even if OPENROUTER_MODEL is unset.
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    baseUrl: process.env.OPENROUTER_BASE_URL ?? OPENROUTER_URL,
    timeoutMs: timeoutMs(),
  };
}

function openAiConfig(): LlmConfig | undefined {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY ?? "";
  if (!apiKey) return undefined;
  return {
    provider: "openai",
    apiKey,
    model: process.env.LLM_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    timeoutMs: timeoutMs(),
  };
}

/**
 * The planner requires an LLM; there is no deterministic runtime fallback. When
 * several keys are configured we try them in order, so a flaky provider (Gemini
 * 503s) fails over instead of taking the product down. Override the order with
 * `LLM_PROVIDER_ORDER=openrouter,gemini`.
 */
export function llmChain(): LlmConfig[] {
  const available: Record<LlmProvider, () => LlmConfig | undefined> = {
    gemini: geminiConfig,
    openrouter: openRouterConfig,
    openai: openAiConfig,
  };
  const order = (process.env.LLM_PROVIDER_ORDER ?? "gemini,openrouter,openai")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is LlmProvider => s in available);
  const chain: LlmConfig[] = [];
  for (const provider of order) {
    const cfg = available[provider]();
    if (cfg) chain.push(cfg);
  }
  return chain;
}

/** First provider in the chain, for callers that only need a yes/no. */
export function llmConfig(): LlmConfig | undefined {
  return llmChain()[0];
}

