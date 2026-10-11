# AGENTS.md

Repo memory for coding agents working on Strategy Studio.

## What this repo is

A single-package TypeScript app: **Strategy Studio**. Natural-language input →
typed `Strategy` → KeeperHub workflow → preview card → approve → execute on
Arbitrum. There is no drag-and-drop UI and no node editor; that is a product
constraint, not a missing feature.

The repo was previously the `agentmaxxing` CLI plus a scaffolded `my-agent`
Next.js demo. Both were removed; Strategy Studio is now the whole repo.

## Layout

| Path | Role |
|---|---|
| `src/strategy/spec.ts` | The typed `Strategy` union. Everything else is an input or output of this shape. |
| `src/strategy/planner.ts` | `validateStrategy` + deterministic helpers (`detectChainId`, …). Reused to normalize LLM output — it does NOT plan at runtime. |
| `src/strategy/llmPlanner.ts` | The planner. Walks the provider chain (Gemini → OpenRouter → OpenAI-compatible). Proposes only; always validated; no regex fallback. |
| `src/strategy/compile.ts` | Spec → KeeperHub nodes + edges. Pure, unit-tested, no network. |
| `src/strategy/tokens.ts`, `prices.ts`, `units.ts` | Addresses/decimals, Chainlink feeds, wei conversion. |
| `src/keeperhub/client.ts` | Thin server-side KeeperHub REST client. |
| `src/server/` | Express API + preview assembly. API key stays server-side. |
| `src/backtest/` | Candle fetch (Binance, synthetic fallback) + pure backtest engine. |
| `src/ui/` | React SPA: composer, preview card, SVG price chart. |
| `test/` | `strategy.test.ts`, `backtest.test.ts` (offline), `live.keeperhub.test.ts` (network). |

## Commands

```bash
npm run dev        # server + Vite
npm test           # offline unit tests (no network, no key)
npm run test:live  # hits KeeperHub; needs .env
npm run typecheck
npm run build
```

## Invariants — do not break

- **Base-denominated sizing.** `sizeUnit: "buy"` must compile to
  `uniswap/swap-exact-output` with an `amountInMaximum` that is
  `min(oracleCap, liveQuote)` (`swapBudget` in `CompilePrices`), and the approve
  must cover the summed budget across all swaps; `"sell"` compiles to
  `swap-exact-input`. `sizeIsBuyDenominated()` in the planner and
  `legSwapNode()`/`approveTotalFor()` in the compiler enforce this. A dollar
  sign forces a spend.
- **Execution is Arbitrum One only** (`EXECUTION_CHAIN = "42161"`). Uniswap V3
  and the Chainlink feeds are not wired up elsewhere, so `compileStrategy`
  throws rather than emitting a broken workflow, and `validateStrategy` rejects
  Sepolia (`421614`) with an explicit message instead of producing a preview
  that can never execute.
- **`/api/execute` requires `{confirmed: true}`.** Never create a workflow
  without it.
- **The planner proposes, it never executes.** Any LLM output runs through
  `normalizeProposal` + `validateStrategy`; an invalid proposal is rejected and
  the chain moves on — it is never "repaired" into a plan the user did not ask for.
- **An LLM is required; there is no regex runtime fallback.** The product input
  is natural language, so a deterministic parser is not a real plan. Providers
  are tried in order (`llmChain()` in `config.ts`, default
  `gemini,openrouter,openai`, override with `LLM_PROVIDER_ORDER`). If every
  provider fails, `/api/plan` returns 503 with the per-provider reasons — never a
  fabricated strategy. `planFromText` survives only as a test fixture.
- **Swaps are single-hop.** Multi-level grids/TWAPs are many single-hop orders;
  that decomposition lives in `compile.ts`.

## Gotchas

- Node/tsx + Vite; `node:test` for tests. No test runner dependency.
- Gemini (`GEMINI_API_KEY`) is intermittent (~503). That is exactly why the
  provider chain exists: OpenRouter (`OPENROUTER_API_KEY`) is the fallback. Never
  reintroduce a deterministic parser as the runtime path.
- KeeperHub workflows are created even when not executed; clean up test
  workflows with `DELETE /api/workflows/:id`.
- Never commit `.env`. It is gitignored; only `.env.example` is tracked.
- **Push access.** The environment's `GITHUB_TOKEN` is a read-only GitHub App
  installation token: pushes and write API calls return 403 ("Resource not
  accessible by integration"). Pushing works only with a user-supplied PAT;
  set it on the remote URL for the single push, then reset the remote back to
  the plain HTTPS URL so the secret is not persisted in `.git/config`.
