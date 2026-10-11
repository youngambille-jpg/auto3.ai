import { useEffect, useState } from "react";
import { PreviewCard } from "./PreviewCard.js";
import type { Preview } from "../server/preview.js";
import type { Strategy } from "../strategy/spec.js";

const EXAMPLES = [
  "TWAP buy 5 ETH with USDC over 6 hours",
  "Grid ETH between 2400 and 2800 with 10 levels, 2 ETH total",
  "Limit buy 1 ETH at 2400 with USDC",
  "DCA 100 USDC into ETH every day for 30 days",
  "Stop loss: sell 1 ETH if price drops to 2200",
];

interface RunState {
  workflowId: string;
  workflowName: string;
  executionId: string;
  status: string;
  steps: string[];
}

interface RunStatus {
  status: string;
  progress?: { percentage: number; completedSteps: number; totalSteps: number } | null;
  transactionHashes: Array<{ hash: string; nodeName?: string }>;
  steps: Array<{ nodeName: string; status: string; error: string | null }>;
  output?: unknown;
}

interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
}

export function App() {
  const [prompt, setPrompt] = useState("");
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [planner, setPlanner] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<StrategyTemplate[]>([]);
  const [deployed, setDeployed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [health, setHealth] = useState<{ walletAddress: string | null; keeperHubAuthOk: boolean; llmConfigured: boolean } | null>(null);
  const [marketWarning, setMarketWarning] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
  }, []);

  async function planStrategy(text: string) {
    setError(null);
    setPreview(null);
    setStrategy(null);
    setMarketWarning(null);
    setTemplates([]);
    setDeployed(null);
    setRun(null);
    setRunStatus(null);
    if (!text.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      });
      const data = await res.json();
      setAssumptions(data.assumptions ?? []);
      setTemplates(data.templateSuggestions ?? []);
      if (!res.ok || data.error) {
        setError(data.error ?? "Could not plan strategy.");
        return;
      }
      setStrategy(data.strategy);
      setPlanner(data.planner ?? "");
      await loadPreview(data.strategy);
      // Validate the pair before the user commits: is there actually a pool?
      const s = data.strategy as Strategy;
      fetch(`/api/markets/pair?tokenIn=${encodeURIComponent(s.sellToken)}&tokenOut=${encodeURIComponent(s.buyToken)}&fee=${s.fee}`)
        .then((r) => r.json())
        .then((p) => setMarketWarning(p.ok ? null : `No live Uniswap pool for this pair at fee ${s.fee}${p.reason ? ` (${p.reason})` : ""}.`))
        .catch(() => setMarketWarning(null));
    } finally {
      setBusy(false);
    }
  }

  async function deployStrategyTemplate(t: StrategyTemplate) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/templates/${t.id}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: t.name }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not deploy template.");
        return;
      }
      setDeployed(data.id);
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview(s: Strategy) {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: s }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not build preview.");
      return;
    }
    setPreview(data.preview);
  }

  async function approveAndExecute() {
    if (!strategy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy, confirmed: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Execution failed.");
        return;
      }
      setRun(data);
      pollRun(data.executionId);
    } finally {
      setBusy(false);
    }
  }

  async function pollRun(executionId: string) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const res = await fetch(`/api/runs/${executionId}`);
      const data = (await res.json()) as RunStatus;
      setRunStatus(data);
      if (data.status && ["success", "error", "cancelled", "system_error"].includes(data.status)) break;
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <h1>Strategy Studio</h1>
        <span className="muted">describe it · preview the card · approve &amp; execute on Arbitrum</span>
        <div className="health">
          <span className={health?.keeperHubAuthOk ? "dot ok" : "dot bad"} />
          {health?.keeperHubAuthOk ? "KeeperHub connected" : "KeeperHub not connected"}
          {health?.llmConfigured ? " · LLM planner" : " · deterministic planner"}
        </div>
      </header>

      <section className="composer">
        <textarea
          value={prompt}
          placeholder="Tell me what you want to do. e.g. TWAP buy 5 ETH with USDC over 6 hours"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) planStrategy(prompt);
          }}
          rows={2}
        />
        <button className="primary" disabled={busy || !prompt.trim()} onClick={() => planStrategy(prompt)}>
          {busy ? "Planning…" : "Preview"}
        </button>
      </section>

      <div className="examples">
        {EXAMPLES.map((e) => (
          <button key={e} className="chip" onClick={() => { setPrompt(e); planStrategy(e); }}>
            {e}
          </button>
        ))}
      </div>

      {assumptions.length > 0 && (
        <div className="assumptions">
          <strong>Assumptions{planner ? ` (${planner})` : ""}:</strong>
          <ul>{assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}

      {error && <div className="errors">{error}</div>}
      {marketWarning && <div className="errors">{marketWarning}</div>}

      {!strategy && templates.length > 0 && (
        <section className="card templates">
          <header className="card-head">
            <h2>Not a strategy we compile — try a template</h2>
          </header>
          <p className="muted small">
            This looks like a monitoring or yield task. These are real KeeperHub workflows you can
            deploy as-is, then tweak.
          </p>
          <ul className="template-list">
            {templates.map((t) => (
              <li key={t.id}>
                <div>
                  <strong>{t.name}</strong>
                  <p className="muted small">{t.description}</p>
                </div>
                <button className="chip" disabled={busy} onClick={() => deployStrategyTemplate(t)}>
                  Deploy
                </button>
              </li>
            ))}
          </ul>
          {deployed && (
            <p className="ok small">Deployed workflow {deployed}. Find it in your KeeperHub org.</p>
          )}
        </section>
      )}

      {strategy && preview && (
        <PreviewCard
          strategy={strategy}
          preview={preview}
          busy={busy}
          onApprove={approveAndExecute}
          onEdit={() => { setPreview(null); setStrategy(null); }}
        />
      )}

      {run && (
        <section className="card run">
          <header className="card-head">
            <h2>Execution</h2>
            <span className={`pill status-${runStatus?.status ?? run.status}`}>{runStatus?.status ?? run.status}</span>
          </header>
          <p className="muted">Workflow {run.workflowName} · id {run.workflowId}</p>
          {runStatus?.progress && (
            <div className="progress">
              <div className="bar" style={{ width: `${runStatus.progress.percentage}%` }} />
              <span>{runStatus.progress.completedSteps}/{runStatus.progress.totalSteps}</span>
            </div>
          )}
          <ol className="steps">
            {(runStatus?.steps ?? run.steps.map((s) => ({ nodeName: s, status: "pending", error: null }))).map((s, i) => (
              <li key={i}>
                <span className={`dot status-${s.status}`} /> {s.nodeName}
                {s.error && <span className="bad"> — {s.error}</span>}
              </li>
            ))}
          </ol>
          {runStatus?.transactionHashes?.length ? (
            <ul className="hashes">
              {runStatus.transactionHashes.map((t) => (
                <li key={t.hash}>
                  {t.nodeName}: <a href={`https://arbiscan.io/tx/${t.hash}`} target="_blank" rel="noreferrer">{t.hash.slice(0, 18)}…</a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No onchain transactions yet.</p>
          )}
          {runStatus?.output != null && (
            <details>
              <summary>Raw output</summary>
              <pre>{JSON.stringify(runStatus.output, null, 2)}</pre>
            </details>
          )}
        </section>
      )}

      <footer className="pagefoot muted small">
        Custody note: execution signs from the KeeperHub-managed wallet for this organization, not a
        scoped session key. Execution is Arbitrum One only; start with small sizes.
      </footer>
    </main>
  );
}
