/**
 * Thin KeeperHub REST client. Every call is server-side so the API key never
 * reaches the browser.
 */

import { KEEPERHUB_BASE_URL, keeperHubKey } from "../config.js";

export interface KeeperHubWorkflow {
  id: string;
  name: string;
  description?: string;
  nodes: unknown[];
  edges: unknown[];
  enabled?: boolean;
}

export interface ExecutionStatus {
  status: string;
  pollIntervalHint?: number;
  progress?: { totalSteps: number; completedSteps: number; percentage: number };
  transactionHashes?: Array<{ hash: string; nodeName?: string; chainId?: number; network?: string }>;
  errorContext?: unknown;
}

export interface ExecutionLogs {
  execution: { id: string; status: string; output?: unknown; error?: string | null };
  logs: Array<{
    nodeId: string;
    nodeName: string;
    nodeType: string;
    status: string;
    output?: unknown;
    error?: string | null;
  }>;
}

export class KeeperHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "KeeperHubError";
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<T> {
  const key = keeperHubKey();
  if (!key) {
    throw new KeeperHubError("KEEPERHUB_API_KEY is not configured on the server.", 500, null);
  }
  const res = await fetch(`${KEEPERHUB_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "strategy-studio/0.1",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : res.statusText;
    throw new KeeperHubError(`KeeperHub ${method} ${path} failed: ${detail}`, res.status, parsed);
  }
  return parsed as T;
}

export const keeperHub = {
  me: () => call<{ id: string; name: string; email: string }>("GET", "/api/user"),
  chains: () => call<Array<{ chainId: number; name: string; isTestnet: boolean; isEnabled: boolean }>>("GET", "/api/chains"),
  wallet: () =>
    call<Array<{ id: string; type: string; address?: string }>>("GET", "/api/integrations"),

  createWorkflow: (wf: { name: string; description?: string; nodes: unknown[]; edges: unknown[]; enabled?: boolean }) =>
    call<KeeperHubWorkflow>("POST", "/api/workflows/create", wf),
  deleteWorkflow: (id: string) => call<{ success: boolean }>("DELETE", `/api/workflows/${id}?force=true`),
  executeWorkflow: (id: string, input: Record<string, unknown> = {}) =>
    call<{ executionId: string; status: string }>("POST", `/api/workflows/${id}/execute`, { input }),
  executionStatus: (executionId: string) =>
    call<ExecutionStatus>("GET", `/api/workflows/executions/${executionId}/status`),
  executionLogs: (executionId: string) =>
    call<ExecutionLogs>("GET", `/api/workflows/executions/${executionId}/logs`),
  waitForReceipt: (executionId: string, timeoutMs = 30_000) =>
    call<{ executionId: string; status: string; completed: boolean; transactionHashes?: unknown[]; error?: string | null }>(
      "GET",
      `/api/workflows/executions/${executionId}/wait?timeoutMs=${timeoutMs}`,
      undefined,
      70_000,
    ),

  /** Direct protocol read, e.g. a live Uniswap quote. */
  protocolQuote: (actionType: string, params: Record<string, unknown>, chainId = "42161") =>
    call<{ success: boolean; result?: { amountOut?: string } }>(
      "POST",
      `/api/execute/${actionType}`,
      { chainId, network: chainId, ...params },
      40_000,
    ),
};
