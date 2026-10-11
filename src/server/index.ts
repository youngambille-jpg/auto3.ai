/**
 * Strategy Studio server. Keeps the KeeperHub API key server-side and exposes a
 * small, explicit API:
 *   POST /api/plan     -> natural language to a validated strategy
 *   POST /api/preview  -> strategy to the preview card payload
 *   POST /api/execute  -> APPROVED strategy to a KeeperHub workflow + run
 *   GET  /api/health   -> config + wallet status
 *   GET  /api/runs/:id -> execution status + logs
 */

import "./env.js";
import express from "express";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { PORT, DEFAULT_CHAIN_ID } from "../config.js";
import { plan } from "../strategy/llmPlanner.js";
import { validateStrategy } from "../strategy/planner.js";
import { buildPreview } from "./preview.js";
import { compileWithContext, resolveMarketContext } from "./context.js";
import { getMarkets, probePair } from "./markets.js";
import { keeperHub, KeeperHubError } from "../keeperhub/client.js";
import { keeperHubMcp } from "../keeperhub/mcp.js";
import { listTemplates, rankTemplates, suggestTemplates, deployTemplate, looksLikeOnchainNeed, type TemplateSummary } from "../keeperhub/templates.js";
import type { Strategy } from "../strategy/spec.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = resolve(__dirname, "../../dist");

function fail(res: express.Response, status: number, message: string, extra: object = {}) {
  res.status(status).json({ error: message, ...extra });
}

app.get("/api/health", async (_req, res) => {
  const hasKey = Boolean(process.env.KEEPERHUB_API_KEY);
  let walletAddress: string | null = null;
  let authOk = false;
  if (hasKey) {
    try {
      const me = await keeperHub.me();
      authOk = Boolean(me?.id);
      const w = await keeperHub.wallet();
      walletAddress = w.find((i) => i.type === "web3")?.address ?? null;
    } catch {
      authOk = false;
    }
  }
  res.json({
    ok: true,
    keeperHubKeyConfigured: hasKey,
    keeperHubAuthOk: authOk,
    walletAddress,
    defaultChainId: DEFAULT_CHAIN_ID,
    llmConfigured: Boolean(
      process.env.GEMINI_API_KEY ?? process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY,
    ),
  });
});

app.get("/api/markets", async (req, res) => {
  const chainId = typeof req.query?.chainId === "string" ? req.query.chainId : DEFAULT_CHAIN_ID;
  try {
    res.json(await getMarkets(chainId));
  } catch (e) {
    fail(res, 502, (e as Error).message);
  }
});

app.get("/api/markets/pair", async (req, res) => {
  const chainId = typeof req.query?.chainId === "string" ? req.query.chainId : DEFAULT_CHAIN_ID;
  const tokenIn = typeof req.query?.tokenIn === "string" ? req.query.tokenIn : "";
  const tokenOut = typeof req.query?.tokenOut === "string" ? req.query.tokenOut : "";
  if (!tokenIn || !tokenOut) return fail(res, 400, "tokenIn and tokenOut are required");
  const fee = typeof req.query?.fee === "string" ? req.query.fee : "500";
  try {
    res.json(await probePair(chainId, tokenIn, tokenOut, fee));
  } catch (e) {
    fail(res, 502, (e as Error).message);
  }
});

app.post("/api/plan", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) return fail(res, 400, "prompt is required");
  if (prompt.length > 2000) return fail(res, 400, "prompt too long (max 2000 chars)");
  const result = await plan(prompt);
  // If we cannot compile the ask but it looks like a real onchain need, offer
  // the closest KeeperHub templates as a starting point.
  let templateSuggestions: TemplateSummary[] = [];
  if (!result.strategy && looksLikeOnchainNeed(prompt)) {
    templateSuggestions = await suggestTemplates(prompt);
  }
  res.json({ ...result, templateSuggestions });
});

app.get("/api/templates", async (req, res) => {
  const query = typeof req.query?.q === "string" ? req.query.q : "";
  try {
    const items = await listTemplates();
    res.json({ templates: query ? rankTemplates(query, items, 10) : items });
  } catch (e) {
    fail(res, 502, (e as Error).message);
  }
});

app.post("/api/templates/:templateId/deploy", async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const out = await deployTemplate(req.params.templateId, name);
    if (!out?.id) return fail(res, 502, "KeeperHub did not return a workflow id");
    res.json(out);
  } catch (e) {
    if (e instanceof KeeperHubError) return fail(res, e.status >= 400 && e.status < 600 ? e.status : 502, e.message, { keeperhub: e.body });
    fail(res, 502, (e as Error).message);
  }
});

app.post("/api/preview", async (req, res) => {
  const strategy = req.body?.strategy as Strategy | undefined;
  if (!strategy) return fail(res, 400, "strategy is required");
  const validation = validateStrategy(strategy);
  if (!validation.ok) return fail(res, 400, "invalid strategy", { validation });
  try {
    const preview = await buildPreview(strategy, {
      withKeeperHubValidation: req.body?.withKeeperHubValidation === true,
    });
    res.json({ strategy, preview });
  } catch (e) {
    fail(res, 500, (e as Error).message);
  }
});

app.post("/api/execute", async (req, res) => {
  const body = req.body ?? {};
  const strategy = body.strategy as Strategy | undefined;
  // The confirm guardrail: nothing is created unless the client explicitly
  // echoes back that the user approved the preview they were shown.
  if (body.confirmed !== true) {
    return fail(res, 400, "Execution requires {confirmed: true} after the user approves the preview.");
  }
  if (!strategy) return fail(res, 400, "strategy is required");

  const validation = validateStrategy(strategy);
  if (!validation.ok) return fail(res, 400, "invalid strategy", { validation });

  let compiled;
  try {
    // Same resolution the preview card used, so what runs matches what was shown.
    const ctx = await resolveMarketContext(strategy);
    compiled = compileWithContext(strategy, ctx);
  } catch (e) {
    return fail(res, 409, `Cannot execute: ${(e as Error).message}`);
  }

  try {
    const wf = await keeperHub.createWorkflow({
      name: compiled.name,
      description: compiled.description,
      nodes: compiled.nodes,
      edges: compiled.edges,
      enabled: false,
    });
    if (!wf?.id) return fail(res, 502, "KeeperHub did not return a workflow id");

    // Validate before spending anything. A clean check plus an enabled flag is
    // what turns the workflow live; a hard error rolls it back.
    const check = await keeperHubMcp.validateWorkflow(wf.id).catch(() => null);
    if (check && !check.valid) {
      await keeperHub.deleteWorkflow(wf.id).catch(() => undefined);
      return fail(res, 422, "KeeperHub rejected the compiled workflow", {
        validation: check,
      });
    }
    await keeperHubMcp.updateWorkflow(wf.id, { enabled: true });

    const run = await keeperHub.executeWorkflow(wf.id, {});
    res.json({
      workflowId: wf.id,
      workflowName: wf.name,
      executionId: run.executionId,
      status: run.status,
      steps: compiled.steps,
      validation: check ?? null,
    });
  } catch (e) {
    if (e instanceof KeeperHubError) return fail(res, e.status >= 400 && e.status < 600 ? e.status : 502, e.message, { keeperhub: e.body });
    fail(res, 502, (e as Error).message);
  }
});

app.get("/api/runs/:executionId", async (req, res) => {
  const id = req.params.executionId;
  try {
    const [status, logs] = await Promise.all([
      keeperHub.executionStatus(id),
      keeperHub.executionLogs(id).catch(() => null),
    ]);
    res.json({
      status: status.status,
      pollIntervalHint: status.pollIntervalHint ?? null,
      progress: status.progress ?? null,
      transactionHashes: status.transactionHashes ?? [],
      errorContext: status.errorContext ?? null,
      output: logs?.execution?.output ?? null,
      steps: (logs?.logs ?? []).map((l) => ({
        nodeId: l.nodeId,
        nodeName: l.nodeName,
        nodeType: l.nodeType,
        status: l.status,
        error: l.error ?? null,
      })),
    });
  } catch (e) {
    if (e instanceof KeeperHubError) return fail(res, e.status >= 400 && e.status < 600 ? e.status : 502, e.message);
    fail(res, 502, (e as Error).message);
  }
});

app.delete("/api/workflows/:workflowId", async (req, res) => {
  try {
    res.json(await keeperHub.deleteWorkflow(req.params.workflowId));
  } catch (e) {
    fail(res, 502, (e as Error).message);
  }
});

// Serve the built SPA when present.
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(WEB_DIST, "index.html")));
}

app.listen(PORT, () => {
  console.log(`strategy-studio server on http://localhost:${PORT}`);
});
