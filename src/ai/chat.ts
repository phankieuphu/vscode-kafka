import * as vscode from "vscode";
import { ClusterManager } from "../kafka/clusterManager";
import { actionsFor, AssistantDeps, AssistantMeta, AssistantRequest, prepareAssistant, runPrepared } from "./assistant";
import { allStoredKeys } from "./keys";
import { prepareModel, resolveProvider } from "./model";
import { AiTask, CHAT_COMMANDS, ChatCommand } from "./prompts";
import { AiMessage, AiModel } from "./providers/types";
import { wrapVscodeModel } from "./providers/vscodeLm";
import { ensureAiConsent, getAiSettings } from "./settings";
import { chatOutput } from "./stream";

export const PARTICIPANT_ID = "kafka-manager.kafka";

interface KafkaChatResult extends vscode.ChatResult {
  metadata: {
    command?: ChatCommand;
    cluster?: string;
    topGroup?: string;
    topic?: string;
  };
}

/** The shared request for a Chat view turn. The panel builds the same for the same text. */
export function fromChatRequest(prompt: string, command: string | undefined, history: AiMessage[], clusterId?: string): AssistantRequest {
  const task: AiTask = (CHAT_COMMANDS as readonly string[]).includes(command ?? "") ? (command as ChatCommand) : "ask";
  return { task, prompt, history, clusterId };
}

/** Earlier `@kafka` turns as plain messages. */
export function chatHistory(chatContext: vscode.ChatContext): AiMessage[] {
  const messages: AiMessage[] = [];
  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push({ role: "user", parts: [{ type: "text", text: turn.prompt }] });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) => (part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : ""))
        .join("");
      if (text) {
        messages.push({ role: "assistant", parts: [{ type: "text", text }] });
      }
    }
  }
  return messages;
}

export async function assistantDeps(manager: ClusterManager): Promise<AssistantDeps> {
  const settings = getAiSettings();
  return {
    manager,
    includeMessagePayloads: settings.includeMessagePayloads,
    maskHosts: settings.maskHosts,
    maxOutputTokens: settings.maxOutputTokens,
    aiKeys: await allStoredKeys(),
  };
}

/** Registers `@kafka` in the Chat view. */
export function registerKafkaChat(context: vscode.ExtensionContext, manager: ClusterManager): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, (request, chatContext, stream, token) =>
    handleRequest(context.globalState, manager, request, chatContext, stream, token),
  );
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "kafka.svg");
  participant.followupProvider = {
    provideFollowups: (result) => followups(result as KafkaChatResult),
  };
  return participant;
}

/**
 * The model for a Chat view turn: the one picked in the chat's model picker
 * when Kafka AI uses VS Code models and no model is pinned; otherwise the
 * Kafka AI provider (Claude, GPT, Gemini…), streamed into the chat.
 */
async function chatModel(state: vscode.Memento, request: vscode.ChatRequest): Promise<{ model: AiModel } | { problem: string }> {
  const settings = getAiSettings();
  const provider = await resolveProvider(settings);
  if (!("problem" in provider) && provider.provider.kind === "vscode" && !settings.model && request.model) {
    if (!vscode.workspace.isTrusted || !settings.enabled) {
      return prepareModel(state);
    }
    const model = wrapVscodeModel(request.model);
    const ok = await ensureAiConsent(state, { id: "vscode", label: model.providerLabel, where: "your VS Code chat model provider" });
    return ok ? { model } : { problem: "AI features need your OK before any data is sent." };
  }
  return prepareModel(state);
}

async function handleRequest(
  state: vscode.Memento,
  manager: ClusterManager,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<KafkaChatResult> {
  const metadata: KafkaChatResult["metadata"] = { command: request.command as ChatCommand | undefined };
  const choice = await chatModel(state, request);
  if ("problem" in choice) {
    stream.markdown(choice.problem);
    stream.button({ title: "Open AI Setup", command: "kafka-manager.aiSetup" });
    return { metadata };
  }
  const { model } = choice;
  const deps = await assistantDeps(manager);
  stream.progress("Reading the cluster…");
  const prepared = await prepareAssistant(deps, model, fromChatRequest(request.prompt, request.command, chatHistory(chatContext)), token);
  fillMetadata(metadata, prepared.meta);
  for (const note of prepared.meta.notes) {
    stream.markdown(`${note}\n\n`);
  }
  if (!prepared.ok) {
    stream.markdown(prepared.message);
    for (const action of prepared.actions) {
      stream.button({ title: action.title, command: action.command, arguments: action.args });
    }
    return { metadata };
  }
  const answer = await runPrepared(deps, model, prepared.built.request, prepared.built.fitted, chatOutput(stream), token);
  if (answer.fitted.dropped.length > 0) {
    stream.markdown(`\n\n_Left out to fit the model: ${answer.fitted.dropped.join(", ")}._`);
  }
  for (const action of actionsFor(prepared.meta)) {
    stream.button({ title: action.title, command: action.command, arguments: action.args });
  }
  return { metadata };
}

function fillMetadata(metadata: KafkaChatResult["metadata"], meta: AssistantMeta): void {
  metadata.cluster = meta.cluster?.name;
  metadata.topGroup = meta.group;
  metadata.topic = meta.topic;
  if ((CHAT_COMMANDS as readonly string[]).includes(meta.task)) {
    metadata.command = meta.task as ChatCommand;
  }
}

function followups(result: KafkaChatResult): vscode.ChatFollowup[] {
  const { command, cluster, topGroup } = result.metadata ?? {};
  if (!cluster) {
    return [];
  }
  const list: vscode.ChatFollowup[] = [];
  if (command !== "diagnose") {
    list.push({ prompt: cluster, command: "diagnose", label: `Health check ${cluster}` });
  }
  if (topGroup && command !== "lag") {
    list.push({ prompt: `${cluster} ${topGroup}`, command: "lag", label: `Why is ${topGroup} lagging?` });
  }
  return list;
}

/** Opens the Chat view on `@kafka`. With `send`, the question is asked straight away; otherwise it is left to finish. */
export function openKafkaChat(query = "", send = false): Thenable<unknown> {
  return vscode.commands.executeCommand("workbench.action.chat.open", {
    query: `@kafka ${query}`.trimEnd() + (send ? "" : " "),
    isPartialQuery: !send,
  });
}
