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

- [ ] 0.1 Call `validate_workflow` on every compiled workflow before
      `/api/execute` creates it, and surface its warnings on the preview card.
      It already flags things we miss, e.g. `approve-without-allowance-check`.
- [ ] 0.2 Use KeeperHub's native actions where they map, instead of raw
      contract reads:
      - `chainlink/eth-usd-latest-round-data` instead of `web3/read-contract`
        + inline ABI for the price read.
      - `web3/check-allowance` upstream of the approve, with a Condition that
        skips the approve when the allowance already covers it (removes a
        pointless transaction per run).
- [ ] 0.3 Template catalog: fetch `GET /api/workflows/public` (118 templates)
      and expose it as a starting point for prompts we cannot compile. For an
      out-of-scope ask ("monitor my Aave health factor"), offer the matching
      template via `deploy_template` rather than failing.
- [ ] 0.4 Compile via the documented path: `deploy_template` (clone) →
      `update_workflow` (replace nodes/edges with ours) → `validate_workflow`.
      Keep `create_workflow` for from-scratch strategies; it is equivalent and
      already tested.
- [ ] 0.5 Add the MCP surface to the client (`deploy_template`,
      `update_workflow`, `validate_workflow`, `search_templates`,
      `list_action_schemas`) behind one thin wrapper, so the strategy code does
      not care whether it talks REST or MCP.

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

- [ ] 2.1 Use `uniswap/quote-exact-output` for buy-denominated sizes so the
      displayed spend and the `amountInMaximum` cap come from a real pool quote
      (oracle becomes the fallback / sanity ceiling).
      - `src/server/preview.ts`, `src/strategy/compile.ts`
- [ ] 2.2 Extract one `resolveExecutionContext(strategy)` helper (wallet + both
      USD prices + compiled workflow) shared by preview and execute.
      - `src/server/index.ts`, `src/server/preview.ts`
- [ ] 2.3 Add `GET /api/markets` sourced from KeeperHub `list_action_schemas`
      so the composer can validate pairs before planning.
      - `src/keeperhub/client.ts`, `src/server/index.ts`

**Acceptance:** preview and execute share one code path; buy-denominated
previews show a live-quote-derived spend.

---

## Phase 3 — Latency: regex-first, LLM-refine

Planning blocked on Gemini for ~45s when it 503s. That is the worst UX problem.

- [ ] 3.1 Return the deterministic plan immediately (<50ms) so the card renders,
      then refine with the LLM and update the card if the proposal validates.
- [ ] 3.2 Show which planner produced the plan and allow a one-click re-plan
      (`deterministic` vs `LLM`).
- [ ] 3.3 Show the reconciliation when LLM and regex disagree instead of
      silently preferring one.

**Acceptance:** first card paint never waits on the network; LLM failure is
invisible except for a label.

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
- There is **no trading-strategy template** (no DCA / TWAP / grid / limit
  order). The catalog is monitoring, yield and wrapping. Our compiler is not
  redundant — it fills a real gap.
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

Both are real: we approve on every run and re-approve an exact amount that the
following swap already consumes.

### Actions / triggers available

- Triggers: `Schedule`, `Event`, `Block`, `Webhook`, `Manual`.
- Native actions we should prefer: `chainlink/eth-usd-latest-round-data`,
  `chainlink/btc-usd-latest-round-data`, `web3/check-allowance`,
  `web3/read-contract`, `web3/approve-token`, `uniswap/swap-exact-input`,
  `uniswap/quote-exact-input`, `discord/send-message`, `code/run-code`,
  `web3/transfer-funds`. 134 distinct action types in the catalog.
- Note: there is no native `uniswap/swap-exact-output` in the template catalog
  (only `quote-exact-output`); our compiler emits `uniswap/swap-exact-input`
  for both legs, which matches the documented action set.

### Template syntax

`{{@nodeId:Label.field}}` for node outputs, `{{input.x}}` for workflow input.
This matches what our compiler already emits.
