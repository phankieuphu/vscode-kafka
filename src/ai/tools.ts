/**
 * Read-only Kafka tools. The same definitions are registered as VS Code
 * Language Model Tools (`#kafka_*` in Copilot agent mode and any tool-calling
 * chat) and offered to the model by Kafka Manager's own agent loop, so
 * Claude, GPT and Gemini can investigate a cluster by themselves.
 *
 * No tool changes anything: no create/delete, offset resets or produce.
 */
import type { ClusterManager } from "../kafka/clusterManager";
import { brokerConfigRisks, topicConfigRisks } from "../kafka/configRules";
import { securityLabel } from "../kafka/connectionConfig";
import { ClusterConfig, ConnectionStatus } from "../kafka/types";
import { ContextSection } from "./budget";
import {
  aclContext,
  brokerContext,
  clusterContext,
  errorContext,
  groupContext,
  messageContext,
  topicContext,
} from "./context";
import { AiToolSpec, CancellationLike, ToolInputSchema } from "./providers/types";
import { redact, RedactOptions } from "./redact";

/** What the tools read; a subset of ClusterManager so tests can fake it. */
export type KafkaReader = Pick<
  ClusterManager,
  | "getClusters"
  | "getStatus"
  | "getClusterOverview"
  | "listTopics"
  | "getTopicDetails"
  | "getTopicConfig"
  | "listConsumerGroups"
  | "getGroupDetails"
  | "fetchGroupOffsets"
  | "listBrokers"
  | "getBrokerDetails"
  | "listAcls"
  | "browse"
  | "getLastError"
  | "getLastHint"
  | "getLastErrorChain"
>;

export interface ToolEnv {
  manager: KafkaReader;
  includeMessagePayloads: boolean;
  /** Redaction for text about these clusters. */
  redaction(clusters: ClusterConfig[]): Promise<RedactOptions>;
}

export interface KafkaTool {
  name: string;
  displayName: string;
  /** For the user (tool picker). */
  userDescription: string;
  /** For the model. */
  modelDescription: string;
  inputSchema: ToolInputSchema;
  /** Reads message contents: gated by kafka.ai.includeMessagePayloads and confirmed. */
  readsPayloads?: boolean;
  run(env: ToolEnv, input: Record<string, unknown>, token: CancellationLike): Promise<ContextSection[] | string>;
}

/** Longest tool result handed to the model. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

const clusterArg = { type: "string" as const, description: "Cluster name as shown in Kafka Manager. Optional when only one cluster is connected." };

export class ToolInputError extends Error {}

function str(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new ToolInputError(`Missing "${key}".`);
    }
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ToolInputError(`"${key}" must be a string.`);
  }
  return String(value).trim();
}

function int(input: Record<string, unknown>, key: string, min: number, max: number, fallback?: number): number | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) {
    throw new ToolInputError(`"${key}" must be a whole number.`);
  }
  return Math.max(min, Math.min(max, n));
}

/**
 * The connected cluster a tool call means: by name or id (case-insensitive),
 * or the only connected one. Never connects by itself.
 */
export function resolveToolCluster(
  clusters: ClusterConfig[],
  status: (id: string) => ConnectionStatus,
  name: string | undefined,
): ClusterConfig {
  if (clusters.length === 0) {
    throw new ToolInputError("No Kafka clusters are configured in Kafka Manager.");
  }
  let cluster: ClusterConfig | undefined;
  if (name) {
    const wanted = name.toLowerCase();
    cluster = clusters.find((c) => c.name.toLowerCase() === wanted || c.id === name);
    if (!cluster) {
      throw new ToolInputError(`No cluster named "${name}". Known clusters: ${clusters.map((c) => c.name).join(", ")}.`);
    }
  } else {
    const connected = clusters.filter((c) => status(c.id) === "connected");
    if (connected.length === 1) {
      cluster = connected[0];
    } else if (connected.length > 1) {
      throw new ToolInputError(`Several clusters are connected (${connected.map((c) => c.name).join(", ")}); say which with "cluster".`);
    } else {
      throw new ToolInputError(`No cluster is connected. Ask the user to connect one in the Kafka view (configured: ${clusters.map((c) => c.name).join(", ")}).`);
    }
  }
  if (status(cluster.id) !== "connected") {
    throw new ToolInputError(`Cluster "${cluster.name}" is ${status(cluster.id)}, not connected. Ask the user to connect it in the Kafka view; tools never connect by themselves.`);
  }
  return cluster;
}

function clusterFrom(env: ToolEnv, input: Record<string, unknown>): ClusterConfig {
  return resolveToolCluster(env.manager.getClusters(), (id) => env.manager.getStatus(id), str(input, "cluster", false));
}

export const KAFKA_TOOLS: KafkaTool[] = [
  {
    name: "kafka_listClusters",
    displayName: "List Kafka Clusters",
    userDescription: "List the Kafka clusters configured in Kafka Manager and whether they are connected.",
    modelDescription:
      "Lists the Apache Kafka clusters configured in Kafka Manager with their connection status and security mode. Call this first to learn cluster names. Other kafka_* tools only work on connected clusters.",
    inputSchema: { type: "object", properties: {} },
    async run(env) {
      const clusters = env.manager.getClusters();
      if (clusters.length === 0) {
        return "No clusters configured.";
      }
      return [
        {
          title: "Clusters",
          priority: 100,
          text: clusters.map((c) => `- ${c.name}: ${env.manager.getStatus(c.id)}, ${securityLabel(c)}, bootstrap ${c.brokers.join(", ")}`).join("\n"),
        },
      ];
    },
  },
  {
    name: "kafka_clusterOverview",
    displayName: "Kafka Cluster Overview",
    userDescription: "Health of a Kafka cluster: brokers, controller, partition problems and consumer lag.",
    modelDescription:
      "Returns a connected Kafka cluster's health: brokers and controller, under-replicated and offline partitions, topics, and consumer groups sorted by lag. Use for health checks and to find lagging groups.",
    inputSchema: { type: "object", properties: { cluster: clusterArg } },
    async run(env, input) {
      return clusterContext(await env.manager.getClusterOverview(clusterFrom(env, input)));
    },
  },
  {
    name: "kafka_listTopics",
    displayName: "List Kafka Topics",
    userDescription: "List the topics of a Kafka cluster.",
    modelDescription: "Lists the topics of a connected Kafka cluster with partition counts. Optionally filter by a substring of the name.",
    inputSchema: {
      type: "object",
      properties: { cluster: clusterArg, filter: { type: "string", description: "Only topics whose name contains this text (case-insensitive)." } },
    },
    async run(env, input) {
      const filter = str(input, "filter", false)?.toLowerCase();
      const topics = (await env.manager.listTopics(clusterFrom(env, input)))
        .filter((t) => !filter || t.name.toLowerCase().includes(filter))
        .sort((a, b) => a.name.localeCompare(b.name));
      return [
        {
          title: `Topics (${topics.length})`,
          priority: 80,
          text: topics.length ? topics.slice(0, 300).map((t) => `- ${t.name}: ${t.partitions.length} partitions`).join("\n") : "None",
        },
      ];
    },
  },
  {
    name: "kafka_describeTopic",
    displayName: "Describe Kafka Topic",
    userDescription: "Partitions, replicas, ISR, message counts and configuration of a topic, with risky settings flagged.",
    modelDescription:
      "Describes one topic of a connected Kafka cluster: partitions with leader, replicas, ISR and message counts; non-default configuration; and Kafka Manager's rule-based risk findings (replication, min.insync.replicas, retention, compaction, leader skew).",
    inputSchema: {
      type: "object",
      properties: { cluster: clusterArg, topic: { type: "string", description: "Topic name." } },
      required: ["topic"],
    },
    async run(env, input) {
      const cluster = clusterFrom(env, input);
      const topic = str(input, "topic")!;
      const [details, config, brokers] = await Promise.all([
        env.manager.getTopicDetails(cluster, topic),
        env.manager.getTopicConfig(cluster, topic),
        env.manager.listBrokers(cluster).catch(() => []),
      ]);
      return topicContext(details, config, topicConfigRisks({ ...details, brokerCount: brokers.length }, config));
    },
  },
  {
    name: "kafka_listConsumerGroups",
    displayName: "List Kafka Consumer Groups",
    userDescription: "List the consumer groups of a Kafka cluster.",
    modelDescription: "Lists the consumer group ids of a connected Kafka cluster. Use kafka_clusterOverview for their lag, or kafka_describeConsumerGroup for one group.",
    inputSchema: { type: "object", properties: { cluster: clusterArg } },
    async run(env, input) {
      const groups = await env.manager.listConsumerGroups(clusterFrom(env, input));
      return [{ title: `Consumer groups (${groups.length})`, priority: 80, text: groups.length ? groups.map((g) => `- ${g.groupId}`).join("\n") : "None" }];
    },
  },
  {
    name: "kafka_describeConsumerGroup",
    displayName: "Describe Kafka Consumer Group",
    userDescription: "State, members, partition assignment and lag per partition of a consumer group.",
    modelDescription:
      "Describes one consumer group of a connected Kafka cluster: state, members and which partitions each owns, and committed offset, end offset and lag per partition (most lag first). Use to explain lag.",
    inputSchema: {
      type: "object",
      properties: { cluster: clusterArg, group: { type: "string", description: "Consumer group id." } },
      required: ["group"],
    },
    async run(env, input) {
      const cluster = clusterFrom(env, input);
      const group = str(input, "group")!;
      const [details, offsets] = await Promise.all([env.manager.getGroupDetails(cluster, group), env.manager.fetchGroupOffsets(cluster, group)]);
      return groupContext(details, offsets);
    },
  },
  {
    name: "kafka_describeBroker",
    displayName: "Describe Kafka Broker",
    userDescription: "A broker's role, rack, partition load and non-default settings, with risky settings flagged.",
    modelDescription:
      "Describes one broker of a connected Kafka cluster: address, controller role, rack, leader and replica counts, non-default settings, and Kafka Manager's rule-based findings. Get broker ids from kafka_clusterOverview.",
    inputSchema: {
      type: "object",
      properties: { cluster: clusterArg, brokerId: { type: "integer", description: "Broker node id." } },
      required: ["brokerId"],
    },
    async run(env, input) {
      const cluster = clusterFrom(env, input);
      const id = int(input, "brokerId", 0, Number.MAX_SAFE_INTEGER);
      if (id === undefined) {
        throw new ToolInputError('Missing "brokerId".');
      }
      const [details, brokers] = await Promise.all([env.manager.getBrokerDetails(cluster, id), env.manager.listBrokers(cluster)]);
      return brokerContext(details, brokerConfigRisks(details.config, brokers, details.rack));
    },
  },
  {
    name: "kafka_listAcls",
    displayName: "List Kafka ACLs",
    userDescription: "The ACLs of a Kafka cluster.",
    modelDescription: "Lists the ACLs of a connected Kafka cluster (resource, pattern, principal, host, operation, permission). Use for authorization errors.",
    inputSchema: { type: "object", properties: { cluster: clusterArg } },
    async run(env, input) {
      return [aclContext(await env.manager.listAcls(clusterFrom(env, input)))];
    },
  },
  {
    name: "kafka_connectionError",
    displayName: "Kafka Connection Error",
    userDescription: "Why a Kafka cluster failed to connect: the error chain and Kafka Manager's hint.",
    modelDescription:
      "Returns the last connection error of a Kafka cluster (connected or not): the full cause chain, the security mode (TLS/SASL mechanism, never credentials) and Kafka Manager's rule-based hint. Use when a cluster is in the error state.",
    inputSchema: {
      type: "object",
      properties: { cluster: { type: "string", description: "Cluster name as shown in Kafka Manager." } },
      required: ["cluster"],
    },
    async run(env, input) {
      const name = str(input, "cluster")!;
      const cluster = env.manager.getClusters().find((c) => c.name.toLowerCase() === name.toLowerCase() || c.id === name);
      if (!cluster) {
        throw new ToolInputError(`No cluster named "${name}".`);
      }
      return errorContext(cluster, env.manager.getLastError(cluster.id), env.manager.getLastErrorChain(cluster.id), env.manager.getLastHint(cluster.id));
    },
  },
  {
    name: "kafka_peekMessages",
    displayName: "Peek Kafka Messages",
    userDescription: "Read the newest few messages of a topic (only with kafka.ai.includeMessagePayloads on).",
    modelDescription:
      "Reads up to 10 of the newest messages of a topic on a connected Kafka cluster, with keys, headers and truncated values. Only works when the user allowed message contents (kafka.ai.includeMessagePayloads).",
    inputSchema: {
      type: "object",
      properties: {
        cluster: clusterArg,
        topic: { type: "string", description: "Topic name." },
        count: { type: "integer", description: "How many messages, 1-10 (default 5)." },
        partition: { type: "integer", description: "Only this partition." },
      },
      required: ["topic"],
    },
    readsPayloads: true,
    async run(env, input, token) {
      if (!env.includeMessagePayloads) {
        throw new ToolInputError(
          "Message contents are not shared with AI. The user can allow it by turning on the kafka.ai.includeMessagePayloads setting.",
        );
      }
      const cluster = clusterFrom(env, input);
      const topic = str(input, "topic")!;
      const count = int(input, "count", 1, 10, 5)!;
      const partition = int(input, "partition", 0, 100_000);
      const result = await env.manager.browse(
        cluster,
        topic,
        { position: { kind: "newest" }, limit: count, partition },
        undefined,
        token as Parameters<ClusterManager["browse"]>[4],
      );
      const messages = result.messages
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
        .slice(0, count);
      if (messages.length === 0) {
        return "The topic has no messages.";
      }
      return messages.map((m) => ({ ...messageContext(topic, m, 500), priority: 50 }));
    },
  },
];

export function findTool(name: string): KafkaTool | undefined {
  return KAFKA_TOOLS.find((t) => t.name === name);
}

/** The tools as specs for a model request. Payload tools only when payloads are allowed. */
export function toolSpecs(includeMessagePayloads: boolean): AiToolSpec[] {
  return KAFKA_TOOLS.filter((t) => includeMessagePayloads || !t.readsPayloads).map((t) => ({
    name: t.name,
    description: t.modelDescription,
    inputSchema: t.inputSchema,
  }));
}

/** Runs a tool and returns redacted, capped text for the model. Errors come back as text so the model can recover. */
export async function runTool(env: ToolEnv, name: string, input: Record<string, unknown>, token: CancellationLike): Promise<string> {
  const tool = findTool(name);
  if (!tool) {
    return `Error: unknown tool "${name}".`;
  }
  try {
    const result = await tool.run(env, input ?? {}, token);
    const text = typeof result === "string" ? result : result.map((s) => `## ${s.title}\n${s.text}`).join("\n\n");
    const safe = redact(text, await env.redaction(env.manager.getClusters()));
    return safe.length > MAX_TOOL_RESULT_CHARS ? `${safe.slice(0, MAX_TOOL_RESULT_CHARS)}\n… [truncated]` : safe;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: ${redact(message, await env.redaction(env.manager.getClusters()))}`;
  }
}
