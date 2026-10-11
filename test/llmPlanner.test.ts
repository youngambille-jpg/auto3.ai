import { test } from "node:test";
import assert from "node:assert/strict";

import { llmChain } from "../src/config.ts";
import { plan } from "../src/strategy/llmPlanner.ts";

const VALID = {
  kind: "twap",
  chainId: "42161",
  sellSymbol: "USDC",
  buySymbol: "ETH",
  fee: "500",
  totalSize: 5,
  sizeUnit: "buy",
  slices: 6,
  intervalMinutes: 60,
};

/** Run `fn` with a patched fetch and a clean LLM env, then restore both. */
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  const keys = ["GEMINI_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENAI_API_KEY", "LLM_API_KEY", "LLM_PROVIDER_ORDER"];
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function geminiBody(obj: unknown) {
  return JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
}
function openAiBody(obj: unknown) {
  return JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] });
}

test("llmChain follows LLM_PROVIDER_ORDER and only includes configured providers", async () => {
  await withEnv({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o", LLM_PROVIDER_ORDER: "openrouter,gemini,openai" }, async () => {
    const chain = llmChain();
    assert.deepEqual(chain.map((c) => c.provider), ["openrouter", "gemini"]);
  });
});

test("llmChain is empty when no provider key is set", async () => {
  await withEnv({}, async () => {
    assert.equal(llmChain().length, 0);
  });
});

test("plan fails over from a broken provider to the next one", async () => {
  await withEnv({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "anthropic/claude-3.5-sonnet", LLM_PROVIDER_ORDER: "gemini,openrouter" }, async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("generativelanguage")) return new Response("boom", { status: 503 });
      if (u.includes("openrouter.ai")) return new Response(openAiBody(VALID), { status: 200 });
      throw new Error(`unexpected url ${u}`);
    }) as typeof fetch;

    const result = await plan("TWAP buy 5 ETH with USDC over 6 hours");
    assert.ok(result.strategy, "the second provider should have produced a strategy");
    assert.equal(result.planner, "llm");
    assert.deepEqual(result.providers.map((p) => [p.provider, p.ok]), [["gemini", false], ["openrouter", true]]);
    assert.match(result.assumptions.join(" "), /failed over/i);
  });
});

test("plan returns an error, not a regex plan, when every provider fails", async () => {
  await withEnv({ GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "o", LLM_PROVIDER_ORDER: "gemini,openrouter" }, async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const result = await plan("TWAP buy 5 ETH with USDC over 6 hours");
    assert.equal(result.strategy, undefined);
    assert.equal(result.planner, "llm");
    assert.match(result.error ?? "", /every provider failed/i);
    assert.equal(result.providers.length, 2);
  });
});

test("a schema-invalid proposal does not fall back to regex", async () => {
  await withEnv({ GEMINI_API_KEY: "g", LLM_PROVIDER_ORDER: "gemini" }, async () => {
    globalThis.fetch = (async () => new Response(geminiBody({ ...VALID, buySymbol: "NOTACOIN" }), { status: 200 })) as typeof fetch;
    const result = await plan("buy something");
    assert.equal(result.strategy, undefined);
    assert.equal(result.planner, "llm");
    assert.match(result.providers[0]!.error ?? "", /Unknown token pair/i);
  });
});

test("plan reports a configuration error when no provider is set", async () => {
  await withEnv({}, async () => {
    const result = await plan("TWAP buy 5 ETH with USDC over 6 hours");
    assert.equal(result.strategy, undefined);
    assert.match(result.error ?? "", /No LLM planner is configured/i);
  });
});
