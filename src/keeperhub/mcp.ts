/**
 * Minimal KeeperHub MCP client. Several capabilities the server needs —
 * validate_workflow, deploy_template, update_workflow, search_templates,
 * list_action_schemas — are only exposed over the MCP JSON-RPC endpoint, not
 * the REST API. The API key stays server-side.
 *
 * MCP needs an `initialize` handshake and a session id, so a module-level
 * session is kept and re-established lazily when the server drops it.
 */

import { KEEPERHUB_BASE_URL, keeperHubKey } from "../config.js";
import { KeeperHubError } from "./client.js";

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let sessionId: string | null = null;
let rpcId = 1;

/** Parse a JSON-RPC body that may arrive as JSON or as an SSE `data:` stream. */
function parseRpcBody(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as JsonRpcResponse;
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload && payload !== "[DONE]") return JSON.parse(payload) as JsonRpcResponse;
    }
  }
  throw new Error("MCP returned no parseable JSON-RPC message");
}

async function post(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ res: Response; text: string }> {
  const key = keeperHubKey();
  if (!key) throw new KeeperHubError("KEEPERHUB_API_KEY is not configured on the server.", 500, null);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "User-Agent": "strategy-studio/0.1",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${KEEPERHUB_BASE_URL}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  return { res, text: await res.text() };
}

async function handshake(): Promise<void> {
  sessionId = null;
  const { text } = await post(
    {
      jsonrpc: "2.0",
      id: rpcId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "strategy-studio", version: "0.1" },
      },
    },
    20_000,
  );
  const init = parseRpcBody(text);
  if (init.error) throw new KeeperHubError(`MCP initialize failed: ${init.error.message}`, 502, init.error);
  // The initialized notification is fire-and-forget; MCP requires it before calls.
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, 20_000);
}

async function rpc(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
  if (!sessionId) await handshake();
  let { res, text } = await post({ jsonrpc: "2.0", id: rpcId++, method, params }, timeoutMs);
  // A dropped session surfaces as 404/400; re-handshake once and retry.
  if (res.status === 404 || (res.status === 400 && /session/i.test(text))) {
    await handshake();
    ({ res, text } = await post({ jsonrpc: "2.0", id: rpcId++, method, params }, timeoutMs));
  }
  if (!res.ok) throw new KeeperHubError(`KeeperHub MCP ${method} failed: ${res.statusText}`, res.status, text);
  const parsed = parseRpcBody(text);
  if (parsed.error) throw new KeeperHubError(`KeeperHub MCP ${method} error: ${parsed.error.message}`, 502, parsed.error);
  return parsed.result;
}

/** Call an MCP tool and unwrap the text payload it returns. */
async function callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await rpc("tools/call", { name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // keep the raw text
  }
  if (result?.isError) {
    throw new KeeperHubError(`KeeperHub tool ${name} failed: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`, 502, parsed);
  }
  return parsed as T;
}

export interface WorkflowValidation {
  valid: boolean;
  nodeCount: number;
  errors?: Array<{ code?: string; message?: string; nodeId?: string }>;
  warnings?: Array<{ code?: string; message?: string; nodeId?: string }>;
}

export const keeperHubMcp = {
  callTool,

  /**
   * Validate a workflow that already lives in the org. KeeperHub has no
   * validate-before-create, so callers create (disabled) then validate.
   */
  validateWorkflow: async (workflowId: string, deepCheck = false): Promise<WorkflowValidation> => {
    const out = await callTool<{ ok?: boolean; result?: WorkflowValidation }>("validate_workflow", { workflowId, deepCheck });
    return (out?.result ?? (out as unknown as WorkflowValidation)) ?? { valid: false, nodeCount: 0 };
  },

  deployTemplate: (templateId: string, name?: string) =>
    callTool<{ id?: string; name?: string }>("deploy_template", { templateId, ...(name ? { name } : {}) }),

  updateWorkflow: (workflowId: string, patch: Record<string, unknown>) =>
    callTool("update_workflow", { workflowId, ...patch }),

  searchTemplates: (query?: string) =>
    callTool<unknown>("search_templates", { ...(query ? { query } : {}) }),

  listActionSchemas: (category?: string) =>
    callTool<unknown>("list_action_schemas", { includeChains: false, ...(category ? { category } : {}) }),
};

/** Exposed for tests; resets the cached MCP session. */
export function resetMcpSession() {
  sessionId = null;
}
