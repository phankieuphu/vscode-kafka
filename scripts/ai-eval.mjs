#!/usr/bin/env node
/**
 * Maintainers only: runs every Kafka AI prompt, built from the recorded
 * fixtures in src/test/fixtures/aiFixtures.ts, against a live model and
 * prints the answers. Nothing here runs in CI.
 *
 *   npm run ai:eval                                   # first provider with a key in the environment
 *   AI_EVAL_PROVIDER=gemini npm run ai:eval
 *   AI_EVAL_PROVIDER=ollama AI_EVAL_MODEL=llama3.2 npm run ai:eval
 *   AI_EVAL_TASKS=diagnose,lag npm run ai:eval
 *
 * Keys come from the usual variables (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY, OPENROUTER_API_KEY, …). AI_EVAL_BASE_URL overrides the endpoint.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = (p) => path.join(root, "out", p);

// The compiled modules import `vscode` for a few helpers; a stub is enough outside VS Code.
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") {
    return { workspace: { getConfiguration: () => ({ get: (_k, d) => d }) }, window: {}, EventEmitter: class { event() {} fire() {} } };
  }
  return load.call(this, request, ...rest);
};

const { PROVIDERS, AUTO_ORDER, getProvider, pickDefaultModel } = require(out("ai/providers/catalog.js"));
const { createHttpModel, listHttpModels } = require(out("ai/providers/httpModel.js"));
const { NEVER_CANCELLED } = require(out("ai/providers/types.js"));
const { prepareAssistant, runPrepared } = require(out("ai/assistant.js"));
const { messageContext, messagesContext } = require(out("ai/context.js"));
const fx = require(out("test/fixtures/aiFixtures.js"));

function pickProvider() {
  const wanted = process.env.AI_EVAL_PROVIDER;
  if (wanted) {
    const p = getProvider(wanted);
    if (!p || p.kind === "vscode") {
      throw new Error(`AI_EVAL_PROVIDER must be one of: ${PROVIDERS.filter((x) => x.kind !== "vscode").map((x) => x.id).join(", ")}`);
    }
    return p;
  }
  const found = AUTO_ORDER.map(getProvider).find((p) => p.envVars.some((v) => process.env[v]));
  if (!found) {
    throw new Error("Set an API key (e.g. ANTHROPIC_API_KEY) or AI_EVAL_PROVIDER=ollama.");
  }
  return found;
}

const provider = pickProvider();
const key = provider.envVars.map((v) => process.env[v]).find(Boolean);
const baseUrl = process.env.AI_EVAL_BASE_URL;
let modelId = process.env.AI_EVAL_MODEL;
if (!modelId) {
  try {
    modelId = pickDefaultModel(provider, await listHttpModels(provider, baseUrl, key, NEVER_CANCELLED));
  } catch (error) {
    console.warn(`Couldn't list models (${error.message}); using the fallback.`);
  }
  modelId ??= provider.fallbackModel;
}
if (!modelId) {
  throw new Error("Set AI_EVAL_MODEL.");
}
const model = createHttpModel({ provider, baseUrl, key, model: modelId, maxOutputTokens: 1200 });

const CASES = [
  { task: "diagnose", clusterId: "c1" },
  { task: "lag", clusterId: "c1", target: { group: "orders-consumer" } },
  { task: "explain-error", clusterId: "c2" },
  { task: "topic-config", clusterId: "c1", target: { topic: "orders" } },
  { task: "broker-config", clusterId: "c1", target: { brokerId: 1 } },
  { task: "explain-decode-error", clusterId: "c1", target: { topic: "orders" }, extra: [messageContext("orders", fx.undecodable)] },
  { task: "infer-schema", clusterId: "c1", target: { topic: "orders" }, extra: [messagesContext("orders", [fx.message, fx.message])] },
  { task: "dashboard-summary", clusterId: "c1" },
  { task: "ask", prompt: "Which consumer group on prod needs attention first, and why?", clusterId: "c1" },
];
const only = process.env.AI_EVAL_TASKS?.split(",").map((s) => s.trim());

console.log(`Kafka AI eval · ${provider.label} · ${modelId}${baseUrl ? ` · ${baseUrl}` : ""}\n`);
let failures = 0;
for (const c of CASES.filter((x) => !only || only.includes(x.task))) {
  const deps = { manager: new fx.FakeManager(), includeMessagePayloads: true, maskHosts: false, aiKeys: [key].filter(Boolean), maxOutputTokens: 1200 };
  const started = Date.now();
  const prepared = await prepareAssistant(deps, model, { task: c.task, prompt: c.prompt ?? "", clusterId: c.clusterId, target: c.target, extraSections: c.extra }, NEVER_CANCELLED);
  console.log(`━━ ${c.task} ${"━".repeat(Math.max(0, 60 - c.task.length))}`);
  if (!prepared.ok) {
    console.log(`(not sent) ${prepared.message}\n`);
    failures++;
    continue;
  }
  const leaked = fx.secretsIn(JSON.stringify(prepared.built.request));
  if (leaked.length) {
    console.log(`!! secrets in prompt: ${leaked.join(", ")}`);
    failures++;
  }
  const answer = await runPrepared(deps, model, prepared.built.request, prepared.built.fitted, { write: (t) => process.stdout.write(t), progress: (t) => process.stdout.write(`\n[${t}]\n`) }, NEVER_CANCELLED);
  const tools = answer.toolCalls.length ? ` · tools: ${answer.toolCalls.map((t) => t.name).join(", ")}` : "";
  console.log(`\n\n(${((Date.now() - started) / 1000).toFixed(1)}s · ~${prepared.built.fitted.tokens} context tokens${tools})${answer.error ? ` ERROR: ${answer.error}` : ""}\n`);
  if (answer.error) {
    failures++;
  }
}
process.exit(failures ? 1 : 0);
