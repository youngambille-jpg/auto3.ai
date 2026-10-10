/** Server-side configuration. All values have safe defaults. */

export const DEFAULT_CHAIN_ID = process.env.STRATEGY_CHAIN_ID ?? "42161";

export const PORT = Number(process.env.PORT ?? 8787);

export const KEEPERHUB_BASE_URL =
  process.env.KEEPERHUB_BASE_URL ?? "https://app.keeperhub.com";

/** Read at call time so tests can set it after import. */
export function keeperHubKey(): string {
  return process.env.KEEPERHUB_API_KEY ?? "";
}

export type LlmProvider = "gemini" | "openai";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/**
 * Optional LLM planner. Prefers Gemini when GEMINI_API_KEY is set; falls back to
 * any OpenAI-compatible endpoint. When nothing is set, the deterministic
 * planner runs instead.
 */
export function llmConfig(): LlmConfig | undefined {
  const gemini = process.env.GEMINI_API_KEY ?? "";
  if (gemini) {
    return {
      provider: "gemini",
      apiKey: gemini,
      model: process.env.GEMINI_MODEL ?? "gemini-flash-latest",
    };
  }
  const openai = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY ?? "";
  if (openai) {
    return {
      provider: "openai",
      apiKey: openai,
      model: process.env.LLM_MODEL ?? "gpt-4o-mini",
      baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    };
  }
  return undefined;
}
