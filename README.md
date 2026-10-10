# Strategy Studio

Describe an on-chain trading strategy in plain English. Preview it as a card.
Approve it. It runs on Arbitrum via [KeeperHub](https://app.keeperhub.com).

No drag-and-drop, no node editor. You write a sentence and the studio turns it
into a typed strategy, a KeeperHub workflow, and a preview card with the live
oracle price, a Uniswap quote, a backtest, and the risks that matter.

## How it works

```
prompt ──▶ planner ──▶ Strategy ──▶ compile ──▶ KeeperHub workflow
           (regex or    (typed      (nodes +    (schedule → approve → swap)
            LLM)         spec)       edges)
                                          │
                                          ▼
                          preview card (price · quote · backtest · risks)
                                          │
                                    Approve & Execute
```

- **Planner** (`src/strategy/planner.ts`, `llmPlanner.ts`) parses the sentence
  into a `Strategy`. A deterministic regex planner always runs; an LLM planner
  (Gemini or any OpenAI-compatible endpoint) is tried first when configured. Any
  LLM proposal is validated against the fixed spec, and anything off falls back
  to the regex planner. The agent proposes, it never executes.
- **Compiler** (`src/strategy/compile.ts`) turns the spec into KeeperHub nodes
  and edges. Swaps, approvals and Chainlink reads only exist on Arbitrum One, so
  the compiler refuses other chains instead of emitting a workflow that fails.
- **Server** (`src/server/index.ts`) keeps the API key server-side and exposes a
  small API. **UI** (`src/ui/`) renders the composer, the preview card and the
  execution status.

## Strategy kinds

| Kind | Example sentence | Compiles to |
|---|---|---|
| `twap` | `TWAP buy 5 ETH with USDC over 6 hours` | Schedule → approve → swap (per slice) |
| `dca` | `DCA 100 USDC into ETH every day for 30 days` | Schedule → approve → swap |
| `grid` | `Grid ETH between 2400 and 2800 with 10 levels, 2 ETH total` | Schedule → read price → band conditions → approve → swap |
| `limit` | `Limit buy 1 ETH at 2400 with USDC` | Schedule → read price → condition → approve → swap |
| `stop` | `Stop loss: sell 1 ETH if price drops to 2200` | Schedule → read price → condition → approve → swap |

### Sizing is base-denominated

`sizeUnit` decides which leg the size counts. `buy 2 ETH` = acquire 2 ETH, and
compiles to a `uniswap/swap-exact-output` order with an oracle-derived
`amountInMaximum`, so "2 ETH" really means 2 ETH and a stale pool cannot drain
the wallet. `spend 100 USDC` = spend 100 USDC, an exact-input swap.

## Setup

```bash
npm install
cp .env.example .env      # then fill in the values
npm run dev               # server + Vite dev server
```

`.env` keys:

| Key | Required | Notes |
|---|---|---|
| `KEEPERHUB_API_KEY` | yes | Server-side only; never reaches the browser |
| `STRATEGY_CHAIN_ID` | no | Default `42161` (Arbitrum One) |
| `PORT` | no | Default `8787` |
| `GEMINI_API_KEY` | no | Enables the LLM planner |
| `OPENAI_API_KEY` / `LLM_API_KEY` | no | OpenAI-compatible fallback planner |

## API

| Route | Purpose |
|---|---|
| `POST /api/plan` | `{prompt}` → strategy + assumptions + planner used |
| `POST /api/preview` | `{strategy}` → preview card payload |
| `POST /api/execute` | `{strategy, confirmed: true}` → creates and runs the KeeperHub workflow |
| `GET /api/health` | config + wallet status |
| `GET /api/runs/:executionId` | execution status + step logs |
| `DELETE /api/workflows/:workflowId` | remove a workflow |

`/api/execute` requires `confirmed: true` — nothing is created unless the client
echoes back that the user approved the preview they were shown.

## Tests

```bash
npm test          # unit: planner, compiler, backtest (no network)
npm run test:live # live KeeperHub: auth, workflow create/delete, read-only execute
npm run typecheck
npm run build
```

## Custody

Execution signs from the organization's KeeperHub-managed wallet, not a scoped
session key. Test on Arbitrum Sepolia and small sizes first. Targeting Arbitrum
One moves real funds.
