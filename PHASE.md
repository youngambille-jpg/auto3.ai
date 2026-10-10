# Strategy Studio — Improvement Plan

Progress tracker. Update the checkboxes as work lands. Each phase is a candidate
PR; keep them independent so one can ship without blocking the others.

Ground rules: the preview card must not lie; the LLM is never load-bearing;
`/api/execute` stays behind `{confirmed: true}`; execution stays Arbitrum One
unless a phase explicitly says otherwise.

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
