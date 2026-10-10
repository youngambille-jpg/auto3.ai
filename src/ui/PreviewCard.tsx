import type { Preview } from "../server/preview.js";
import type { Strategy } from "../strategy/spec.js";
import { PriceChart } from "./PriceChart.js";

interface Props {
  strategy: Strategy;
  preview: Preview;
  onApprove: () => void;
  onEdit: () => void;
  busy: boolean;
}

/**
 * The preview card: a read-only summary the user approves. There is no drag
 * editor; the strategy is either exactly what they described or they edit the
 * text. This is the product surface, so it stays dense and honest.
 */
export function PreviewCard({ strategy, preview, onApprove, onEdit, busy }: Props) {
  const bt = preview.backtest;
  const canExecute = preview.validation.ok && preview.steps.length > 0 &&
    !preview.risks.some((r) => r.startsWith("Not executable"));

  return (
    <section className="card" aria-label="Strategy preview">
      <header className="card-head">
        <div>
          <h2>{preview.workflow.name || "Strategy"}</h2>
          <p className="muted">{preview.workflow.description}</p>
        </div>
        <span className="pill">{strategy.kind.toUpperCase()}</span>
      </header>

      <dl className="facts">
        <Fact label="Pair" value={`${strategy.sellSymbol} → ${strategy.buySymbol}`} />
        <Fact label="Chain" value="Arbitrum One (execution)" />
        <Fact label="Size" value={`${strategy.totalSize} ${strategy.sizeUnit === "buy" ? strategy.buySymbol : strategy.sellSymbol}`} />
        {preview.chainlinkPrice != null && (
          <Fact label="Oracle price" value={`$${preview.chainlinkPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        )}
        {preview.quote && (
          <Fact
            label="Live quote"
            value={`${Number(preview.quote.avgPrice).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${strategy.buySymbol}/${strategy.sellSymbol}${
              preview.quote.slippagePct != null ? ` · ${preview.quote.slippagePct.toFixed(2)}% vs oracle` : ""
            }`}
          />
        )}
        <Fact label="Wallet" value={preview.walletAddress ? short(preview.walletAddress) : "not configured"} />
      </dl>

      <div className="cols">
        <div>
          <h3>What will run</h3>
          <ol className="steps">
            {preview.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
        <div>
          <h3>Backtest preview</h3>
          {bt ? (
            <>
              <PriceChart result={bt} strategy={strategy} />
              <ul className="metrics">
                <li>Price change: {bt.summary.priceChangePct.toFixed(2)}%</li>
                <li>Fills: {bt.summary.numberOfFills} ({Math.round(bt.summary.filledFraction * 100)}% of size)</li>
                {bt.summary.avgFillPrice != null && (
                  <li>Avg execution: {bt.summary.avgFillPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</li>
                )}
                {bt.summary.edgeVsHold != null && (
                  <li className={bt.summary.edgeVsHold >= 0 ? "good" : "bad"}>
                    vs hold: {bt.summary.edgeVsHold >= 0 ? "+" : ""}
                    {bt.summary.edgeVsHold.toFixed(2)}
                  </li>
                )}
              </ul>
              <p className="muted small">
                {bt.summary.note} <span className="tag">data: {preview.candlesSource}</span>
              </p>
            </>
          ) : (
            <p className="muted">No backtest available.</p>
          )}
        </div>
      </div>

      {preview.risks.length > 0 && (
        <div className="risks">
          <h3>Risks &amp; caveats</h3>
          <ul>
            {preview.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {!preview.validation.ok && (
        <div className="errors">
          {preview.validation.errors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}

      <footer className="card-actions">
        <button className="ghost" onClick={onEdit} disabled={busy}>Edit description</button>
        <button className="primary" onClick={onApprove} disabled={busy || !canExecute}>
          {busy ? "Executing…" : "Approve & Execute"}
        </button>
      </footer>
      <p className="muted small">
        Nothing is sent onchain until you approve. Execution runs from your KeeperHub-managed wallet.
      </p>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
