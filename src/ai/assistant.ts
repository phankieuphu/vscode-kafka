/**
 * The shared request path for every AI answer: `@kafka` in the Chat view,
 * the Kafka AI panel and the Explain buttons. Gathers context for the task,
 * builds the prompt (redacted, within budget) and runs the model, with the
 * read-only Kafka tools for free-form questions.
 */
import { describeError } from "../kafka/clusterManager";
import { brokerConfigRisks, topicConfigRisks } from "../kafka/configRules";
import { ClusterConfig } from "../kafka/types";
import { runAgent } from "./agent";
import { BudgetResult, ContextSection } from "./budget";
import {
  brokerContext,
  clusterContext,
  clusterSection,
  errorContext,
  findMentioned,
  groupContext,
  mostLaggingGroup,
  resolveChatTarget,
  topicContext,
} from "./context";
import { AiTask, budgetFor, buildRequest, BuiltRequest } from "./prompts";
import { AiMessage, AiModel, AiRequest, CancellationLike } from "./providers/types";
import { redactionFor, RedactOptions } from "./redact";
import { AiOutput, streamModelResponse } from "./stream";
import { KafkaReader, runTool, ToolEnv, toolSpecs } from "./tools";

export interface AssistantDeps {
  manager: KafkaReader & { getStoredSecrets(id: string): Promise<string[]> };
  includeMessagePayloads: boolean;
  maskHosts: boolean;
  maxOutputTokens?: number;
  /** Stored AI API keys: never allowed into a prompt. */
  aiKeys: string[];
}

export interface AssistantTarget {
  group?: string;
  topic?: string;
  brokerId?: number;
  /** Whether the messages the user has loaded had keys (topic config checks for compaction). */
  keysSeen?: boolean;
}

export interface AssistantRequest {
  task: AiTask;
  /** What the user typed (may be empty for one-click tasks). */
  prompt: string;
  /** The cluster the panel or tree item is about; a cluster named in the prompt wins. */
  clusterId?: string;
  target?: AssistantTarget;
  /** Context the caller already has: a message, sampled messages, lag readings. */
  extraSections?: ContextSection[];
  history?: AiMessage[];
  /** Offer the Kafka tools; defaults to free-form questions only. */
  useTools?: boolean;
}

/** What an answer was about, for follow-ups and action buttons. */
export interface AssistantMeta {
  task: AiTask;
  cluster?: ClusterConfig;
  group?: string;
  topic?: string;
  brokerId?: number;
  /** Shown before the answer, e.g. which cluster or group was picked. */
  notes: string[];
}

/** A Kafka Manager command offered next to an answer. The AI never runs these itself. */
export interface AssistantAction {
  title: string;
  command: string;
  args: unknown[];
}

export type Prepared =
  | { ok: true; built: BuiltRequest; meta: AssistantMeta; redaction: RedactOptions }
  | { ok: false; message: string; meta: AssistantMeta; actions: AssistantAction[] };

/** Tasks that read live data and need a connection. */
function needsConnection(task: AiTask): boolean {
  return task !== "explain-error" && task !== "explain-message" && task !== "explain-decode-error" && task !== "infer-schema";
}

async function redactionOf(deps: AssistantDeps, clusters: ClusterConfig[]): Promise<RedactOptions> {
  const stored = (await Promise.all(clusters.map((c) => deps.manager.getStoredSecrets(c.id)))).flat();
  return redactionFor(clusters, [...stored, ...deps.aiKeys], deps.maskHosts);
}

/** Reads what `task` needs from the cluster. Fills `meta` for follow-ups. */
export async function gatherSections(
  manager: KafkaReader,
  cluster: ClusterConfig,
  task: AiTask,
  rest: string,
  target: AssistantTarget,
  meta: AssistantMeta,
): Promise<ContextSection[]> {
  const sections = [clusterSection(cluster, manager.getStatus(cluster.id))];
  switch (task) {
    case "explain-error":
      return [
        ...sections,
        ...errorContext(cluster, manager.getLastError(cluster.id), manager.getLastErrorChain(cluster.id), manager.getLastHint(cluster.id)),
      ];
    case "explain-message":
    case "explain-decode-error":
    case "infer-schema":
      meta.topic = target.topic;
      return sections;
    case "lag":
    case "lag-alert": {
      let groupId = target.group;
      if (!groupId) {
        const groups = (await manager.listConsumerGroups(cluster)).map((g) => g.groupId);
        groupId = findMentioned(rest, groups);
      }
      if (!groupId) {
        groupId = mostLaggingGroup(await manager.getClusterOverview(cluster));
        if (!groupId) {
          throw new Error("This cluster has no consumer groups.");
        }
        meta.notes.push(`No group named, so looking at **${groupId}**, the group with the most lag.`);
      }
      meta.group = groupId;
      const [details, offsets] = await Promise.all([manager.getGroupDetails(cluster, groupId), manager.fetchGroupOffsets(cluster, groupId)]);
      return [...sections, ...groupContext(details, offsets)];
    }
    case "topic":
    case "topic-config": {
      let topic = target.topic;
      if (!topic) {
        const topics = (await manager.listTopics(cluster)).map((t) => t.name);
        topic = findMentioned(rest, topics);
        if (!topic) {
          throw new Error(`Name one of this cluster's topics, e.g. \`/topic ${topics[0] ?? "orders"}\`.`);
        }
      }
      meta.topic = topic;
      const [details, config, brokers] = await Promise.all([
        manager.getTopicDetails(cluster, topic),
        manager.getTopicConfig(cluster, topic),
        manager.listBrokers(cluster).catch(() => []),
      ]);
      const risks = topicConfigRisks({ ...details, brokerCount: brokers.length, keysSeen: target.keysSeen }, config);
      return [...sections, ...topicContext(details, config, risks)];
    }
    case "broker-config": {
      const brokers = await manager.listBrokers(cluster);
      const id = target.brokerId ?? brokers.find((b) => b.isController)?.nodeId ?? brokers[0]?.nodeId;
      if (id === undefined) {
        throw new Error("The cluster reported no brokers.");
      }
      meta.brokerId = id;
      const details = await manager.getBrokerDetails(cluster, id);
      return [...sections, ...brokerContext(details, brokerConfigRisks(details.config, brokers, details.rack))];
    }
    default: {
      const overview = await manager.getClusterOverview(cluster);
      meta.group = mostLaggingGroup(overview);
      return [...sections, ...clusterContext(overview)];
    }
  }
}

/** Picks the cluster, gathers context and builds the request. Never throws. */
export async function prepareAssistant(
  deps: AssistantDeps,
  model: Pick<AiModel, "maxInputTokens" | "countTokens">,
  req: AssistantRequest,
  token: CancellationLike,
): Promise<Prepared> {
  const { manager } = deps;
  let task = req.task;
  const meta: AssistantMeta = { task, notes: [] };
  const clusters = manager.getClusters();
  const resolved = resolveChatTarget(req.prompt, clusters, (id) => manager.getStatus(id), req.clusterId);
  const cluster = resolved.cluster;
  if (!cluster) {
    return {
      ok: false,
      meta,
      message: clusters.length === 0 ? "No Kafka clusters are configured yet." : "Which cluster? Name it in your question, or connect one first.",
      actions: [{ title: "Add Cluster", command: "kafka-manager.addCluster", args: [] }],
    };
  }
  meta.cluster = cluster;
  if (resolved.note) {
    meta.notes.push(resolved.note);
  }
  const status = manager.getStatus(cluster.id);
  if (needsConnection(task) && status !== "connected") {
    if (status === "error") {
      meta.notes.push(`**${cluster.name}** failed to connect. Here is why:`);
      task = "explain-error";
      meta.task = task;
    } else {
      return {
        ok: false,
        meta,
        message: `**${cluster.name}** isn't connected. Connect it, then ask again.`,
        actions: [{ title: `Connect ${cluster.name}`, command: "kafka-manager.connectCluster", args: [{ cluster }] }],
      };
    }
  }

  let sections: ContextSection[];
  try {
    sections = await gatherSections(manager, cluster, task, resolved.rest, req.target ?? {}, meta);
  } catch (error) {
    return { ok: false, meta, message: `Couldn't read the cluster: ${describeError(error)}`, actions: [] };
  }
  sections.push(...(req.extraSections ?? []));
  if (token.isCancellationRequested) {
    return { ok: false, meta, message: "Cancelled.", actions: [] };
  }

  const useTools = (req.useTools ?? task === "ask") && status === "connected";
  const redaction = await redactionOf(deps, clusters);
  const built = await buildRequest({
    task,
    sections,
    question: resolved.rest,
    history: req.history,
    redaction,
    budget: budgetFor(model.maxInputTokens),
    count: (text) => model.countTokens(text, token),
    tools: useTools ? toolSpecs(deps.includeMessagePayloads) : undefined,
    maxOutputTokens: deps.maxOutputTokens,
  });
  return { ok: true, built, meta, redaction };
}

export interface AssistantAnswer {
  text: string;
  error?: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  fitted: BudgetResult;
}

/** Runs a prepared request: the agent loop when tools are offered, else a plain stream. */
export async function runPrepared(
  deps: AssistantDeps,
  model: AiModel,
  request: AiRequest,
  fitted: BudgetResult,
  out: AiOutput,
  token: CancellationLike,
): Promise<AssistantAnswer> {
  if (request.tools?.length) {
    const env: ToolEnv = {
      manager: deps.manager,
      includeMessagePayloads: deps.includeMessagePayloads,
      redaction: (clusters) => redactionOf(deps, clusters),
    };
    const result = await runAgent(model, request, (name, input, t) => runTool(env, name, input, t), out, token);
    return { text: result.text, error: result.error, toolCalls: result.toolCalls, fitted };
  }
  const text = await streamModelResponse(model, request, out, token);
  return { text: text ?? "", error: text === undefined ? "failed" : undefined, toolCalls: [], fitted };
}

/** The commands that act on what was discussed; the user stays in control. */
export function actionsFor(meta: AssistantMeta): AssistantAction[] {
  const cluster = meta.cluster;
  if (!cluster) {
    return [];
  }
  switch (meta.task) {
    case "explain-error":
      return [
        { title: "Edit Connection Security", command: "kafka-manager.editClusterSecurity", args: [{ cluster }] },
        { title: "Reconnect", command: "kafka-manager.reconnectCluster", args: [{ cluster }] },
      ];
    case "lag":
    case "lag-alert": {
      if (!meta.group) {
        return [];
      }
      const item = { cluster, group: { groupId: meta.group } };
      return [
        { title: "View Group", command: "kafka-manager.viewConsumerGroup", args: [item] },
        { title: "Reset Offsets…", command: "kafka-manager.resetGroupOffsets", args: [item] },
        { title: "Watch Lag…", command: "kafka-manager.watchGroupLag", args: [item] },
      ];
    }
    case "topic":
    case "topic-config":
    case "explain-message":
    case "explain-decode-error":
    case "infer-schema":
      return meta.topic ? [{ title: "Browse Messages", command: "kafka-manager.viewTopic", args: [{ cluster, topic: { name: meta.topic } }] }] : [];
    case "broker-config":
      return meta.brokerId !== undefined
        ? [{ title: `Broker ${meta.brokerId}`, command: "kafka-manager.viewBroker", args: [{ cluster, broker: { nodeId: meta.brokerId } }] }]
        : [];
    default: {
      const list: AssistantAction[] = [{ title: "Open Cluster Dashboard", command: "kafka-manager.openDashboard", args: [{ cluster }] }];
      if (meta.group) {
        list.push({ title: `View ${meta.group}`, command: "kafka-manager.viewConsumerGroup", args: [{ cluster, group: { groupId: meta.group } }] });
      }
      return list;
    }
  }
}
