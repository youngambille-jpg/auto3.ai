/**
 * Template catalog fallback. When a prompt is a real onchain need we do not
 * compile (monitoring, yield, health factors, wrapping), offer the closest
 * KeeperHub public template instead of failing. The user can then deploy it.
 *
 * The catalog is small and read-only, so it is cached for a few minutes.
 */

import { keeperHub } from "./client.js";
import { keeperHubMcp } from "./mcp.js";

export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  isTradingStrategy: boolean;
}

interface CachedCatalog {
  at: number;
  items: TemplateSummary[];
}

const TTL_MS = 5 * 60_000;
let cache: CachedCatalog | null = null;

const TRADING_RE = /\b(dca|twap|grid|limit order|stop[- ]?loss|take[- ]?profit|dollar[- ]?cost)\b/i;

export function isTradingTemplate(name: string, description = ""): boolean {
  return TRADING_RE.test(`${name} ${description}`);
}

/** Only surface templates that do something onchain, not demo/probe rows. */
function isUseful(t: { name: string; description?: string | null }): boolean {
  if (t.name === "test") return false;
  if (/^[a-z]+-0x[0-9a-f]+-\d+$/i.test(t.name)) return false; // generated duplicates
  return true;
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.items;
  const raw = await keeperHub.listPublicTemplates();
  const items = raw
    .filter(isUseful)
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      isTradingStrategy: isTradingTemplate(t.name, t.description ?? ""),
    }));
  cache = { at: Date.now(), items };
  return items;
}

const STOPWORDS = new Set([
  "the", "a", "an", "my", "me", "i", "to", "of", "and", "or", "for", "on", "in",
  "with", "when", "then", "at", "is", "are", "be", "if", "so", "that", "this",
  "auto", "auto-", "monitor", "watch", "alert", "check", "track", "tracker",
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

/** Rank templates against a prompt by keyword overlap (name weighted over body). */
function score(prompt: Set<string>, t: TemplateSummary): number {
  const name = keywords(t.name);
  const body = keywords(t.description);
  let s = 0;
  for (const w of prompt) {
    if (name.has(w)) s += 3;
    else if (body.has(w)) s += 1;
  }
  return s;
}

export function rankTemplates(
  prompt: string,
  templates: TemplateSummary[],
  limit = 3,
): TemplateSummary[] {
  const p = keywords(prompt);
  return templates
    .map((t) => ({ t, s: score(p, t) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
    .slice(0, limit)
    .map((x) => x.t);
}

/** True when the ask looks like an onchain need our compiler does not cover. */
export function looksLikeOnchainNeed(prompt: string): boolean {
  return /\b(monitor|health|factor|liquidat|yield|stake|staking|steth|reth|lido|aave|compound|morpho|yearn|compound|supply|borrow|repay|wrap|unwrap|portfolio|balance|peg|depeg|oracle|bridge|claim|rewards|payroll|salary)\b/i.test(
    prompt,
  );
}

/**
 * Suggest templates for a prompt that could not be compiled into a strategy.
 * Returns an empty list when the catalog is unavailable or nothing matches.
 */
export async function suggestTemplates(prompt: string): Promise<TemplateSummary[]> {
  try {
    return rankTemplates(prompt, await listTemplates());
  } catch {
    return [];
  }
}

/** Clone a public template into the org; returns the new workflow id. */
export async function deployTemplate(templateId: string, name?: string): Promise<{ id?: string; name?: string }> {
  return keeperHubMcp.deployTemplate(templateId, name);
}
