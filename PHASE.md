# Strategy Studio — Improvement Plan

Progress tracker. Update the checkboxes as work lands. Each phase is a candidate
PR; keep them independent so one can ship without blocking the others.

Ground rules: the preview card must not lie; the LLM is never load-bearing;
`/api/execute` stays behind `{confirmed: true}`; execution stays Arbitrum One
unless a phase explicitly says otherwise.

---

## Phase 0 — KeeperHub-native foundation

KeeperHub *is* a workflow engine, and it already ships the building blocks we
are hand-rolling. Findings are in the appendix below. This phase adopts them.

- [x] 0.1 Validate before executing. KeeperHub's `validate_workflow` needs an
      existing workflow id (no validate-before-create), so `/api/execute` now
      creates the workflow **disabled**, validates it, and only then enables and
      runs it; a hard error rolls the workflow back and returns the findings.
      The preview can also surface KeeperHub's warnings via
      `{withKeeperHubValidation: true}`, which creates, validates and deletes a
      throwaway copy.
- [x] 0.2 Use KeeperHub's native actions where they map, instead of raw
      contract reads:
      - `chainlink/eth-usd-latest-round-data` instead of `web3/read-contract`
        + inline ABI for the price read. Covered for ETH, WETH, BTC, WBTC,
        LINK, USDC, DAI, USDT; other symbols keep the registry fallback.
      - `web3/check-allowance` upstream of the approve, with a Condition that
        skips the approve when the allowance already covers it (removes a
        pointless transaction per run). The check reads `allowanceRaw` and the
        gate fires the approve only on the `true` branch.
      A `create_workflow` + `validate_workflow` pass over all five strategy
      kinds now reports **zero warnings** (the old `Limit buy 50 ETH` reported
      `approve-without-allowance-check`), so this work also satisfies 0.1's
      intent for the approve path.
- [x] 0.3 Template catalog fallback. `src/keeperhub/templates.ts` caches
      `GET /api/workflows/public`, filters out demo/probe rows, ranks by keyword
      overlap against the prompt, and `GET /api/templates?q=` exposes it.
      `/api/plan` attaches `templateSuggestions` when the ask fails to compile
      **and** looks like an onchain need (monitor / health / yield / stake / …),
      so "monitor my Aave health factor" returns the three real Aave templates.
      The composer shows them with a Deploy button
      (`POST /api/templates/:id/deploy`), which clones via MCP `deploy_template`.
- [x] 0.4 Compile via the documented path. `create_workflow` stays the
      from-scratch path (equivalent to clone → replace and already tested);
      `deploy_template` → `update_workflow` → `validate_workflow` is wired
      through `src/keeperhub/mcp.ts` for template-based flows, and the deploy
      endpoint exercises the clone step live.
- [x] 0.5 Add the MCP surface to the client (`deploy_template`,
      `update_workflow`, `validate_workflow`, `search_templates`,
      `list_action_schemas`) behind one thin wrapper, so the strategy code does
      not care whether it talks REST or MCP.
      - `src/keeperhub/mcp.ts` handles the JSON-RPC handshake and session,
        parses both JSON and SSE bodies, re-handshakes on a dropped session,
        and unwraps tool payloads. `validate_workflow` is wired into
        preview/execute; the rest is exposed for Phase 0.3/0.4.

**Acceptance:** a preview shows KeeperHub's validation warnings; a price read
uses a native action; an uncompilable prompt offers a real template.

---

## Phase 1 — Correctness: make the preview honest

The card's only value is that it is true. Fix the math before adding anything.

- [x] 1.1 Rewrite backtest accounting around a single cash/base ledger keyed by
      `sizeUnit`, so `edgeVsHold` and equity are correct for buy-denominated and
      grid strategies.
      - `src/backtest/engine.ts`
- [x] 1.2 Direction-aware triggers: a fill requires an approach direction.
      - buy-limit / stop-loss fill on a downward cross (previous close above the
        trigger, then traded through it)
      - sell-limit / stop-buy fill on an upward cross
      - `src/backtest/engine.ts` (`simulateTrigger`)
- [x] 1.3 Stop treating Arbitrum Sepolia (`421614`) as executable. Execution is
      Arbitrum One only, so reject Sepolia in `validateStrategy` and stop
      returning it from `detectChainId`, with a clear message. Leave the chain
      registry entry for a future testnet support phase.
      - `src/strategy/planner.ts`
- [x] 1.4 Remove dead code and the no-op ternary.
      - `keeperHub.actionSchemas()`, `readChainlink()` — `src/keeperhub/client.ts`
      - `splitEvenly()` — `src/strategy/units.ts`
      - `priceToRaw()` — `src/strategy/prices.ts`
      - `assetPriceFromCandle` no-op ternary — `src/backtest/engine.ts`
      - Keep `waitForReceipt` (live test) and `rawToPrice` (preview).
- [x] 1.5 Remove the now-invalid Sepolia test assertions and add regression
      tests for 1.1–1.3.
      - `test/strategy.test.ts`, `test/backtest.test.ts`

**Acceptance:** `npm test` (27 pass / 0 fail / 3 skipped), `npm run typecheck`,
`npm run build` all green and new tests cover each fix. Verified end-to-end via
`/api/plan` + `/api/preview` and the browser UI.

---

## Phase 2 — Make the preview real

- [x] 2.1 Buy-denominated sizes now quote through `uniswap/quote-exact-output`.
      The per-swap `amountInMaximum` is `min(oracleCap, liveQuote)`, and the
      approve is widened to cover the summed budget across all swaps
      (`swapBudget * units * 1.05`). The oracle stays as the fallback ceiling.
      - `src/server/context.ts`, `src/strategy/compile.ts`, `src/server/preview.ts`
- [x] 2.2 One `resolveMarketContext(strategy)` helper (wallet + both USD prices
      + live swap budget + display budget) shared by preview and execute, so the
      card the user approves is exactly what runs.
      - `src/server/context.ts`, `src/server/index.ts`, `src/server/preview.ts`
- [x] 2.3 `GET /api/markets` (registry tokens + Uniswap actions from
      `list_action_schemas`) and `GET /api/markets/pair` (a live probe) let the
      composer reject a pair with no pool before it plans/executes.
      - `src/server/markets.ts`, `src/server/index.ts`, `src/ui/App.tsx`

**Acceptance:** preview and execute share one code path; buy-denominated
previews show a live-quote-derived spend. Verified live: the cap equals the
quoted `amountIn` (e.g. 2087128569 USDC wei) and beats the oracle estimate.

---

## Phase 2.5 — UI: "quiet instrument" (design pass)

The first UI read like a generic dark dashboard. This pass gives it a point of
view, borrowing Perplexity's brand trio (Offblack `#091717`, Paper White
`#FBFAF4`, True Turquoise `#20808D`) and its editorial display type.

- [x] 2.5.1 New design system in `src/ui/styles.css`: deep teal-tinted surface,
      one luminous turquoise accent (`#2fd6c6`) over the brand teal
      (`#20808d`), hairline borders, a single soft glow. Fraunces (display
      serif) + Instrument Sans (UI) + JetBrains Mono (all figures), loaded in
      `index.html`.
- [x] 2.5.2 Restructured shell in `src/ui/App.tsx`: brand mark + wordmark, an
      editorial hero ("Describe the trade. *We'll build it, show it, run it.*"),
      and a Perplexity-style composer — one large rounded input with the primary
      action anchored inside it and a ⌘/Ctrl+Enter hint.
- [x] 2.5.3 Component pass: `PreviewCard` facts become a hairline grid with
      mono figures; steps become numbered chips; `PriceChart` sits on the new
      surface. Reduced-motion is respected.

**Acceptance:** no drag-and-drop; the composer is the only input; every render
path (compiled strategy, grid + chart, template suggestions) looks intentional.
Verified live in the browser.

---

## Phase 3 — LLM-only planner with a provider fallback chain

The old design leaned on a deterministic regex planner as the "reliability
backbone" and fell back to it whenever the LLM was down. But the product's only
input is natural language, so a regex parse is not a real plan — it silently
shipped a strategy the user never described. This phase removes it from the
runtime path and makes the LLM reliable instead.

- [x] 3.1 Provider-chain fallback. `llmChain()` in `src/config.ts` builds the
      ordered list of configured providers (default `gemini,openrouter,openai`,
      override with `LLM_PROVIDER_ORDER`). `plan()` walks it and returns the
      first schema-valid proposal; a provider that errors, times out, or
      proposes something invalid is recorded and skipped.
- [x] 3.2 No regex runtime fallback. `plan()` no longer calls `planFromText`.
      When every provider fails, `/api/plan` returns **503** with the
      per-provider reasons; it never fabricates a plan. `planFromText` is kept
      only as a test fixture.
- [x] 3.3 OpenRouter wired in as an OpenAI-compatible provider
      (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL`, default `openai/gpt-4o-mini`),
      with attribution headers. `/api/health` now reports the active chain and
      the UI shows it (`LLM: gemini → openrouter`).

**Acceptance:** with Gemini down, the same prompt is answered by OpenRouter; if
all providers fail the user sees an honest error, never a regex plan. Covered by
`test/llmPlanner.test.ts` (fails over; errors on total failure; a schema-invalid
proposal does not fall back).

---

## Phase 3b — Latency: stream the plan, don't block the paint (was 3.1–3.3)

Planning blocks on the network. Once the LLM is required, the first paint must
still not wait on it.

- [ ] 3b.1 Stream progress so the card can show "planning…" with the provider
      being tried, rather than a blank 45s wait.
- [ ] 3b.2 Show which provider produced the plan and allow a one-click re-plan
      (e.g. force OpenRouter).

**Acceptance:** the composer always acknowledges input immediately; provider
failure is visible, not silent.

---

## Phase 4 — Grid that actually grids

- [ ] 4.1 Stateful grid: track filled levels in KeeperHub workflow state so a
      fill at one level does not repeat every interval.
- [ ] 4.2 Evaluate `Event`/`Block` triggers so fills are price-driven rather
      than cron-driven.

**Acceptance:** a 10-level grid places at most one order per level, ever.

---

## Phase 5 — Product surface (confirm before building)

- [ ] 5.1 Persist executions so users can see run history (today runs are
      ephemeral).
- [ ] 5.2 Auth on the web app: `/api/execute` moves real funds with no user auth.
- [ ] 5.3 More strategies: multi-hop routes, DCA with a price cap, take-profit
      ladders, trailing stops.

---

## Status log

| Date | Change |
|---|---|
| — | Plan created. |
| 2026-10-10 | Phase 1 complete: honest backtest ledger, direction-aware triggers, Sepolia rejected, dead code removed. 27 tests pass. |
| 2026-10-10 | KeeperHub recon: template catalog, MCP tools, validate_workflow. Phase 0 added. |
| 2026-10-10 | Phase 0.2 done: native Chainlink reads + check-allowance gate. All 5 strategy kinds validate warning-free in KeeperHub. |
| 2026-10-10 | Phase 0.1 + 0.5 done: MCP client, execute validates (create-disabled → validate → enable), preview validation on demand. 35 tests pass incl. 4 live. |
| 2026-10-10 | Phase 0.3 + 0.4 done: template fallback (`/api/templates`, suggestions on un-compilable asks, deploy via MCP). 40 tests pass. |
| 2026-10-10 | Phase 2 done: live `quote-exact-output` caps buy-denominated swaps, shared market context for preview/execute, `/api/markets` + pair probe. 42 tests pass. |
| 2026-10-10 | Phase 2.5 done: Perplexity-inspired "quiet instrument" UI pass (turquoise/offblack system, Fraunces display, composer-first layout). Build + 42 tests green; verified live. |
| 2026-10-11 | Phase 3 done: LLM-only planner with a Gemini → OpenRouter → OpenAI-compatible fallback chain; regex removed from the runtime path (503 on total failure). 48 tests pass. |
| 2026-10-11 | Phase 3 hardening: `LLM_TIMEOUT_MS` default raised 20s → 45s after live verification showed a reasoning fallback model needs ~14s for a full plan; the old default aborted it. Verified end-to-end in the browser. |

---

## Appendix — KeeperHub capabilities (verified 2026-10-10)

All of the below was called against `app.keeperhub.com` with the org key.

### Template catalog

- `GET /api/workflows/public` → **118 public templates**, fully parameterized
  (real token addresses, amounts, cron, Discord webhook placeholders). Examples:
  "Uniswap Swap Quote Tracker", "WETH Auto-Wrap ETH on Schedule", "Aave V3
  Health Factor Guardian", "Chainlink: Oracle Staleness Monitor", "Aerodrome
  veAERO Epoch Voter", "Yearn Vault Auto-Depositor", "Lido stETH Auto-Wrapper".
- `GET /api/workflows/{id}` returns one template in full.
- There are **no curated trading-strategy templates** (no DCA / TWAP / grid /
  limit order). A handful of generated clones (`dca-<addr>-<ts>`,
  `payroll-…`) look trading-ish but are user artifacts, not products. The
  catalog is monitoring, yield, payroll and wrapping; our compiler fills a
  real gap and the catalog is only a fallback for what we do not compile.
- `POST /api/workflows/{id}/duplicate` clones a template. Body overrides are
  **ignored**; `POST .../deploy_template` (MCP) is the intended clone.

### MCP server (`/mcp`, JSON-RPC)

Requires `initialize` then `notifications/initialized` (session id in the
`mcp-session-id` response header). 45 tools. The ones that matter here:

| Tool | Use |
|---|---|
| `search_templates` / `get_template` | Browse the 118 templates (`query` is currently ignored; returns all). |
| `deploy_template` | Clone a template into the org. Verified working. |
| `update_workflow` | Replace a workflow's nodes/edges/enabled. **This is how we parameterize a clone.** Verified working. |
| `validate_workflow` | Structural + Web3 validation. Verified working, see below. |
| `create_workflow` | From-scratch create; supports `idempotency_key`. |
| `ai_generate_workflow` | KeeperHub's own NL→workflow generator. Currently returns `upstream_cold_start`; retry later. |
| `list_action_schemas` | Catalog of actions, triggers, chains. |
| `search_workflows` | Listed (paid, callable) workflows, not templates. |

### What `validate_workflow` caught on our existing `Limit buy 50 ETH`

```
approve-without-allowance-check
  nodes[3] approves spender 0x24de…c141 without reading the current allowance
  first: no web3/check-allowance node is upstream of it.
signer-routing-key-ignored
  …
```

Both are real: we approved on every run and re-approved an exact amount that the
following swap already consumes. Phase 0.2 fixes the first; the second is about
which signer key routes the node and is handled by leaving `_protocolMeta`
unset. After 0.2, all five strategy kinds validate with **zero warnings**.

### Allowance gate semantics (verified)

Confirmed by building a probe workflow with `create_workflow` and validating it:

- A node may have **two incoming edges**; KeeperHub accepts the diamond where
  the allowance Condition's `false` branch and the `approve →` edge both land on
  the swap. No merge node is required.
- A Condition must carry a `sourceHandle` of `"true"` / `"false"` on its outgoing
  edges; the graph branch is selected by that handle.
- `web3/check-allowance` outputs `allowanceRaw` (wei string) and `allowance`
  (human). The gate compares `allowanceRaw < required` and approves only then.
- Condition groups need **unique `group.id` per node**; we key them by node id.

### Actions / triggers available

- Triggers: `Schedule`, `Event`, `Block`, `Webhook`, `Manual`.
- Native actions we prefer: `chainlink/{eth,btc,link,usdc,dai,usdt}-usd-latest-round-data`
  (structured `result.answer`), `web3/check-allowance`, `web3/read-contract`,
  `web3/approve-token`, `uniswap/swap-exact-input`, `uniswap/swap-exact-output`,
  `uniswap/quote-exact-input`, `discord/send-message`, `code/run-code`,
  `web3/transfer-funds`. 134 distinct action types in the catalog.
- No native Chainlink action for ARB, so that symbol keeps the
  `web3/read-contract` + registry-ABI fallback.

### Template syntax

`{{@nodeId:Label.field}}` for node outputs, `{{input.x}}` for workflow input.
Native Chainlink reads expose `result.answer` (raw int), so the price ref is
`{{@read-1:Read ETH/USD.result.answer}}`; the generic read exposes `result`.
Both are the shape our compiler now emits.
