import * as vscode from "vscode";
import { ClusterManager } from "../kafka/clusterManager";
import { AssistantRequest, prepareAssistant, runPrepared } from "./assistant";
import { assistantDeps } from "./chat";
import { prepareModel, selectModel } from "./model";
import { hasAiConsent } from "./settings";
import { AiOutput, bufferOutput } from "./stream";

export interface InlineResult {
  ok: boolean;
  /** Model and provider, for a footnote. */
  model?: string;
  error?: string;
}

/**
 * Answers `req` into `out` outside any chat (dashboard summary card).
 * Goes through the same gate and request path as the chat.
 */
export async function runInline(
  state: vscode.Memento,
  manager: ClusterManager,
  req: AssistantRequest,
  out: AiOutput,
  token: vscode.CancellationToken,
): Promise<InlineResult> {
  const choice = await prepareModel(state);
  if ("problem" in choice) {
    return { ok: false, error: choice.problem };
  }
  const deps = await assistantDeps(manager);
  const prepared = await prepareAssistant(deps, choice.model, req, token);
  if (!prepared.ok) {
    return { ok: false, error: prepared.message.replace(/\*\*/g, "") };
  }
  const answer = await runPrepared(deps, choice.model, prepared.built.request, prepared.built.fitted, out, token);
  return { ok: !answer.error, model: `${choice.model.name} · ${choice.model.providerLabel}`, error: answer.error };
}

/**
 * A one-sentence answer for a background notification. Only runs when the
 * data notice for the current provider was already accepted (never prompts),
 * and gives up after `timeoutMs`.
 */
export async function oneLiner(
  state: vscode.Memento,
  manager: ClusterManager,
  req: AssistantRequest,
  timeoutMs = 30_000,
): Promise<string | undefined> {
  const choice = await selectModel();
  if ("problem" in choice || !hasAiConsent(state, choice.destination) || !vscode.workspace.isTrusted) {
    return undefined;
  }
  const source = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => source.cancel(), timeoutMs);
  try {
    const deps = { ...(await assistantDeps(manager)), maxOutputTokens: 200 };
    const prepared = await prepareAssistant(deps, choice.model, { ...req, prompt: `${req.prompt} Answer in one sentence of at most 30 words.`.trim() }, source.token);
    if (!prepared.ok) {
      return undefined;
    }
    const out = bufferOutput();
    const answer = await runPrepared(deps, choice.model, prepared.built.request, prepared.built.fitted, out, source.token);
    const text = out.text().replace(/\s+/g, " ").replace(/[*_`#]/g, "").trim();
    return answer.error || !text ? undefined : text.length > 240 ? `${text.slice(0, 237)}…` : text;
  } finally {
    clearTimeout(timer);
    source.dispose();
  }
}
