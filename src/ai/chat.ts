import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig, ClusterOverview } from "../kafka/types";
import { ContextSection, fitToBudget } from "./budget";
import {
  clusterSection,
  errorSection,
  findMentioned,
  groupSections,
  overviewSections,
  resolveChatTarget,
  topicSections,
} from "./chatContext";
import { getCurrentModel, prepareModel } from "./model";
import { redact, redactionFor } from "./redact";
import { getAiSettings } from "./settings";
import { chatOutput, streamModelResponse } from "./stream";

export const PARTICIPANT_ID = "kafka-manager.kafka";
/** Most context tokens sent per request, however large the model's window. */
const CONTEXT_BUDGET = 8000;

type Command = "diagnose" | "lag" | "explain-error" | "topic";

interface KafkaChatResult extends vscode.ChatResult {
  metadata: {
    command?: Command;
    cluster?: string;
    topGroup?: string;
    topic?: string;
  };
}

const INSTRUCTIONS = [
  "You are the Kafka Manager assistant inside VS Code. You help with the user's Apache Kafka cluster.",
  "Base your answer on the context below, which Kafka Manager just read from the cluster. If something isn't in it, say so instead of guessing.",
  "You cannot change the cluster. When an action is needed, name the Kafka Manager command that does it (Reset Group Offsets, Edit Connection Security, Open Cluster Dashboard, Browse Messages, Create Topic).",
  "Lead with the conclusion. Be concise and use Markdown.",
].join("\n");

const TASKS: Record<Command | "ask", string> = {
  diagnose:
    "Give a health check: offline or under-replicated partitions, controller, broker leader skew, consumer groups that are Empty/Dead/rebalancing, and the groups with the most lag. Rank problems by severity; say clearly if everything looks healthy.",
  lag: "Explain this consumer group's lag. Say whether it is one stuck partition, lag spread across all partitions, partitions without a consumer, or an uneven assignment, and what to check next.",
  "explain-error":
    "Explain why connecting to this cluster failed. Give the most likely causes in order, each with concrete steps (Docker advertised.listeners, MSK ports 9092/9094/9096/9098, TLS vs plaintext, SASL mechanism, credentials).",
  topic:
    "Explain this topic's layout and configuration. Flag risky settings, such as min.insync.replicas >= replication factor, replication factor 1, unbounded retention or leaders piled on one broker.",
  ask: "Answer the user's question.",
};

/** Registers `@kafka` in the Chat view. */
export function registerKafkaChat(
  context: vscode.ExtensionContext,
  manager: ClusterManager,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    (request, chatContext, stream, token) =>
      handleRequest(
        context.globalState,
        manager,
        request,
        chatContext,
        stream,
        token,
      ),
  );
  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "resources",
    "kafka.svg",
  );
  participant.followupProvider = {
    provideFollowups: (result) => followups(result as KafkaChatResult),
  };
  return participant;
}

async function handleRequest(
  state: vscode.Memento,
  manager: ClusterManager,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<KafkaChatResult> {
  const command = request.command as Command | undefined;
  const metadata: KafkaChatResult["metadata"] = { command };

  const choice = await prepareModel(state);
  if ("problem" in choice) {
    stream.markdown(choice.problem);
    stream.button({ title: "Open AI Setup", command: "kafka-manager.aiSetup" });
    return { metadata };
  }
  // Prefer the model picked in the chat view; fall back to the one from settings.
  const model = getAiSettings().modelFamily
    ? choice.model
    : (request.model ?? choice.model);

  const target = resolveChatTarget(
    request.prompt,
    manager.getClusters(),
    (id) => manager.getStatus(id),
  );
  const cluster = target.cluster;
  if (!cluster) {
    stream.markdown(
      manager.getClusters().length === 0
        ? "No Kafka clusters are configured yet."
        : "Which cluster? Name it in your question, or connect one first.",
    );
    stream.button({
      title: "Add Cluster",
      command: "kafka-manager.addCluster",
    });
    return { metadata };
  }
  metadata.cluster = cluster.name;
  if (target.note) {
    stream.markdown(`${target.note}\n\n`);
  }

  const status = manager.getStatus(cluster.id);
  const wantsLive = command !== "explain-error";
  if (wantsLive && status !== "connected") {
    if (status === "error") {
      stream.markdown(
        `**${cluster.name}** failed to connect. Here is why:\n\n`,
      );
      return answer("explain-error");
    }
    stream.markdown(
      `**${cluster.name}** isn't connected. Connect it, then ask again.`,
    );
    stream.button({
      title: `Connect ${cluster.name}`,
      command: "kafka-manager.connectCluster",
      arguments: [{ cluster }],
    });
    return { metadata };
  }
  return answer(command);

  async function answer(cmd: Command | undefined): Promise<KafkaChatResult> {
    metadata.command = cmd;
    let sections: ContextSection[];
    try {
      stream.progress(`Reading ${cluster!.name}…`);
      sections = await gather(
        manager,
        cluster!,
        cmd,
        target.rest,
        metadata,
        stream,
      );
    } catch (error) {
      stream.markdown(`Couldn't read the cluster: ${describeError(error)}`);
      return { metadata };
    }
    if (token.isCancellationRequested) {
      return { metadata };
    }

    const settings = getAiSettings();
    const options = redactionFor(
      [cluster!],
      await manager.getStoredSecrets(cluster!.id),
      settings.maskHosts,
    );
    const safe = sections.map((s) => ({ ...s, text: redact(s.text, options) }));
    const budget = Math.min(
      CONTEXT_BUDGET,
      Math.floor(model.maxInputTokens / 2),
    );
    const fitted = await fitToBudget(safe, budget, (text) =>
      model.countTokens(text, token),
    );

    const messages = [
      vscode.LanguageModelChatMessage.User(
        `${INSTRUCTIONS}\n\nTask: ${TASKS[cmd ?? "ask"]}`,
      ),
      ...history(chatContext, options),
      vscode.LanguageModelChatMessage.User(
        `# Context\n\n${fitted.text}\n\n# Question\n\n${redact(target.rest || "(no extra question)", options)}`,
      ),
    ];
    await streamModelResponse(model, messages, chatOutput(stream), token);
    if (fitted.dropped.length > 0) {
      stream.markdown(
        `\n\n_Left out to fit the model: ${fitted.dropped.join(", ")}._`,
      );
    }
    addButtons(stream, cluster!, cmd, metadata);
    return { metadata };
  }
}

/** Reads what `cmd` needs from the cluster. Sets `metadata` for follow-ups. */
async function gather(
  manager: ClusterManager,
  cluster: ClusterConfig,
  cmd: Command | undefined,
  rest: string,
  metadata: KafkaChatResult["metadata"],
  stream: vscode.ChatResponseStream,
): Promise<ContextSection[]> {
  const sections = [clusterSection(cluster, manager.getStatus(cluster.id))];
  switch (cmd) {
    case "explain-error":
      return [
        ...sections,
        errorSection(
          manager.getLastError(cluster.id),
          manager.getLastHint(cluster.id),
        ),
      ];
    case "lag": {
      const groups = (await manager.listConsumerGroups(cluster)).map(
        (g) => g.groupId,
      );
      let groupId = findMentioned(rest, groups);
      if (!groupId) {
        groupId = await topLaggingGroup(manager, cluster);
        if (!groupId) {
          throw new Error("This cluster has no consumer groups.");
        }
        stream.markdown(
          `No group named, so looking at **${groupId}**, the group with the most lag.\n\n`,
        );
      }
      metadata.topGroup = groupId;
      const [details, offsets] = await Promise.all([
        manager.getGroupDetails(cluster, groupId),
        manager.fetchGroupOffsets(cluster, groupId),
      ]);
      return [...sections, ...groupSections(details, offsets)];
    }
    case "topic": {
      const topics = (await manager.listTopics(cluster)).map((t) => t.name);
      const topic = findMentioned(rest, topics);
      if (!topic) {
        throw new Error(
          `Name one of this cluster's topics, e.g. \`/topic ${topics[0] ?? "orders"}\`.`,
        );
      }
      metadata.topic = topic;
      const [details, config] = await Promise.all([
        manager.getTopicDetails(cluster, topic),
        manager.getTopicConfig(cluster, topic),
      ]);
      return [...sections, ...topicSections(details, config)];
    }
    default: {
      const overview = await manager.getClusterOverview(cluster);
      metadata.topGroup = mostLagging(overview);
      return [...sections, ...overviewSections(overview)];
    }
  }
}

async function topLaggingGroup(
  manager: ClusterManager,
  cluster: ClusterConfig,
): Promise<string | undefined> {
  return mostLagging(await manager.getClusterOverview(cluster));
}

function mostLagging(overview: ClusterOverview): string | undefined {
  let top: { groupId: string; lag: bigint } | undefined;
  for (const g of overview.groups) {
    const lag = BigInt(g.totalLag || "0");
    if (lag > 0n && (!top || lag > top.lag)) {
      top = { groupId: g.groupId, lag };
    }
  }
  return top?.groupId ?? overview.groups[0]?.groupId;
}

/** Earlier `@kafka` turns, so follow-up questions have context. */
function history(
  chatContext: vscode.ChatContext,
  options: ReturnType<typeof redactionFor>,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];
  for (const turn of chatContext.history.slice(-6)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(
        vscode.LanguageModelChatMessage.User(redact(turn.prompt, options)),
      );
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) =>
          part instanceof vscode.ChatResponseMarkdownPart
            ? part.value.value
            : "",
        )
        .join("");
      if (text) {
        messages.push(
          vscode.LanguageModelChatMessage.Assistant(redact(text, options)),
        );
      }
    }
  }
  return messages;
}

/** Links to the commands that act on what was discussed; the user stays in control. */
function addButtons(
  stream: vscode.ChatResponseStream,
  cluster: ClusterConfig,
  cmd: Command | undefined,
  metadata: KafkaChatResult["metadata"],
): void {
  switch (cmd) {
    case "explain-error":
      stream.button({
        title: "Edit Connection Security",
        command: "kafka-manager.editClusterSecurity",
        arguments: [{ cluster }],
      });
      stream.button({
        title: "Reconnect",
        command: "kafka-manager.reconnectCluster",
        arguments: [{ cluster }],
      });
      break;
    case "lag":
      if (metadata.topGroup) {
        const item = { cluster, group: { groupId: metadata.topGroup } };
        stream.button({
          title: "View Group",
          command: "kafka-manager.viewConsumerGroup",
          arguments: [item],
        });
        stream.button({
          title: "Reset Offsets…",
          command: "kafka-manager.resetGroupOffsets",
          arguments: [item],
        });
      }
      break;
    case "topic":
      if (metadata.topic) {
        stream.button({
          title: "Browse Messages",
          command: "kafka-manager.viewTopic",
          arguments: [{ cluster, topic: { name: metadata.topic } }],
        });
      }
      break;
    default:
      stream.button({
        title: "Open Cluster Dashboard",
        command: "kafka-manager.openDashboard",
        arguments: [{ cluster }],
      });
  }
}

function followups(result: KafkaChatResult): vscode.ChatFollowup[] {
  const { command, cluster, topGroup } = result.metadata ?? {};
  if (!cluster) {
    return [];
  }
  const list: vscode.ChatFollowup[] = [];
  if (command !== "diagnose") {
    list.push({
      prompt: cluster,
      command: "diagnose",
      label: `Health check ${cluster}`,
    });
  }
  if (topGroup && command !== "lag") {
    list.push({
      prompt: `${cluster} ${topGroup}`,
      command: "lag",
      label: `Why is ${topGroup} lagging?`,
    });
  }
  return list;
}

/** Opens the Chat view on `@kafka`. With `send`, the question is asked straight away; otherwise it is left to finish. */
export function openKafkaChat(query = "", send = false): Thenable<unknown> {
  return vscode.commands.executeCommand("workbench.action.chat.open", {
    query: `@kafka ${query}`.trimEnd() + (send ? "" : " "),
    isPartialQuery: !send
  });
}
