/**
 * Context builders: turn what ClusterManager returns into compact Markdown
 * sections for prompts and tools. Pure (no `vscode`), so they are unit-tested;
 * redaction and the token budget are applied where the prompt is built
 * (`prompts.ts`), so every builder goes through both.
 */
import { ConfigRisk, formatRisks } from "../kafka/configRules";
import { ErrorLink } from "../kafka/connectionHints";
import { securityLabel } from "../kafka/connectionConfig";
import { LagFinding, LagSample, LagTrend, formatHistory } from "../kafka/lagTrend";
import {
  AclEntry,
  BrokerDetails,
  ClusterConfig,
  ClusterOverview,
  ConnectionStatus,
  ConsumedMessage,
  GroupDetails,
  GroupOffsetEntry,
  TopicConfigEntry,
  TopicDetails,
} from "../kafka/types";
import { ContextSection } from "./budget";
import { MAX_PAYLOAD_CHARS, truncatePayload } from "./redact";

/** Rows shown before a list is summarised as "…and N more". */
const MAX_ROWS = 25;
/** Rows in a panel table. */
const MAX_TABLE_ROWS = 50;

export interface ChatTarget {
  cluster?: ClusterConfig;
  /** The prompt with the cluster name taken out. */
  rest: string;
  /** Why this cluster was picked, when it wasn't named. */
  note?: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which cluster a chat request is about: one named in the prompt (longest
 * name wins), else `preferred` (the panel's or tree selection's cluster), else
 * the only/first connected one, else the only one configured.
 */
export function resolveChatTarget(
  prompt: string,
  clusters: ClusterConfig[],
  status: (id: string) => ConnectionStatus,
  preferred?: string,
): ChatTarget {
  const text = prompt.trim();
  const named = [...clusters]
    .sort((a, b) => b.name.length - a.name.length)
    .find((c) => new RegExp(`(^|\\s)${escapeRegExp(c.name)}(?=\\s|$|[?.,!])`, "i").test(text));
  if (named) {
    const rest = text
      .replace(new RegExp(`(^|\\s)${escapeRegExp(named.name)}(?=\\s|$|[?.,!])`, "i"), " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    return { cluster: named, rest };
  }
  const pick = preferred ? clusters.find((c) => c.id === preferred) : undefined;
  if (pick) {
    return { cluster: pick, rest: text };
  }
  const connected = clusters.filter((c) => status(c.id) === "connected");
  if (connected.length === 1) {
    return { cluster: connected[0], rest: text };
  }
  if (connected.length > 1) {
    return {
      cluster: connected[0],
      rest: text,
      note: `Using **${connected[0].name}**. Name another cluster in your question to ask about it instead.`,
    };
  }
  if (clusters.length === 1) {
    return { cluster: clusters[0], rest: text };
  }
  return { rest: text };
}

/** The longest of `names` that appears in `text` as a whole word, e.g. a group or topic. */
export function findMentioned(text: string, names: string[]): string | undefined {
  return [...names]
    .sort((a, b) => b.length - a.length)
    .find((name) => new RegExp(`(^|[\\s\`'"])${escapeRegExp(name)}(?=$|[\\s\`'"?.,!:])`, "i").test(text));
}

function capped<T>(rows: T[], line: (row: T) => string, max = MAX_ROWS): string {
  const shown = rows.slice(0, max).map(line);
  if (rows.length > max) {
    shown.push(`- …and ${rows.length - max} more`);
  }
  return shown.join("\n");
}

function table(columns: string[], rows: string[][]): ContextSection["table"] {
  return { columns, rows: rows.slice(0, MAX_TABLE_ROWS) };
}

function compareBig(a: string, b: string): number {
  const x = BigInt(a || "0");
  const y = BigInt(b || "0");
  return x < y ? -1 : x > y ? 1 : 0;
}

// ---- Cluster -----------------------------------------------------------------

/** Name, status and security mode (TLS/SASL mechanism only, never secrets). */
export function clusterSection(cluster: ClusterConfig, status: ConnectionStatus): ContextSection {
  return {
    title: "Cluster",
    priority: 100,
    text: [
      `- Name: ${cluster.name}`,
      `- Status: ${status}`,
      `- Bootstrap servers: ${cluster.brokers.join(", ")}`,
      `- Security: ${securityLabel(cluster)}`,
      `- Schema Registry: ${cluster.schemaRegistry ? "configured" : "none"}`,
    ].join("\n"),
  };
}

/** From `getClusterOverview`: brokers, controller, partition health, topic and group counts, lag. */
export function clusterContext(overview: ClusterOverview): ContextSection[] {
  const t = overview.totals;
  const sections: ContextSection[] = [
    {
      title: "Health",
      priority: 90,
      text: [
        `- Brokers: ${t.brokers}, controller: ${overview.controllerId ?? "none"}`,
        `- Topics: ${t.topics}, partitions: ${t.partitions}`,
        `- Under-replicated partitions: ${t.underReplicated}, offline partitions: ${t.offline}`,
        `- Consumer groups: ${t.groups}, total lag: ${t.totalLag}`,
      ].join("\n"),
    },
    {
      title: "Brokers",
      priority: 60,
      text: capped(
        overview.brokers,
        (b) => `- ${b.nodeId}${b.isController ? " (controller)" : ""}: ${b.host}:${b.port}, leads ${b.leaderCount}, replicas ${b.replicaCount}`,
      ),
      table: table(
        ["Broker", "Host", "Role", "Leaders", "Replicas"],
        overview.brokers.map((b) => [String(b.nodeId), `${b.host}:${b.port}`, b.isController ? "controller" : "broker", String(b.leaderCount), String(b.replicaCount)]),
      ),
    },
  ];
  const unhealthy = overview.topics.filter((topic) => topic.underReplicated > 0 || topic.offline > 0);
  if (unhealthy.length > 0) {
    sections.push({
      title: "Topics with partition problems",
      priority: 80,
      text: capped(unhealthy, (topic) => `- ${topic.name}: ${topic.underReplicated} under-replicated, ${topic.offline} offline, RF ${topic.replicationFactor}`),
      table: table(
        ["Topic", "Under-replicated", "Offline", "RF"],
        unhealthy.map((x) => [x.name, String(x.underReplicated), String(x.offline), String(x.replicationFactor)]),
      ),
    });
  }
  const lagging = [...overview.groups].sort((a, b) => compareBig(b.totalLag, a.totalLag));
  sections.push(
    {
      title: "Consumer groups (most lag first)",
      priority: 70,
      text: lagging.length
        ? capped(lagging, (g) => `- ${g.groupId}: ${g.state}, ${g.memberCount} members, lag ${g.totalLag}, topics ${g.topics.join(", ") || "none"}`)
        : "None",
      table: lagging.length
        ? table(["Group", "State", "Members", "Lag"], lagging.map((g) => [g.groupId, g.state, String(g.memberCount), g.totalLag]))
        : undefined,
    },
    {
      title: "Topics",
      priority: 20,
      text: capped(overview.topics, (topic) => `- ${topic.name}: ${topic.partitionCount} partitions, RF ${topic.replicationFactor}, ${topic.messageCount} messages`),
    },
  );
  return sections;
}

/** The group with the most lag, else the first. */
export function mostLaggingGroup(overview: ClusterOverview): string | undefined {
  let top: { groupId: string; lag: bigint } | undefined;
  for (const g of overview.groups) {
    const lag = BigInt(g.totalLag || "0");
    if (lag > 0n && (!top || lag > top.lag)) {
      top = { groupId: g.groupId, lag };
    }
  }
  return top?.groupId ?? overview.groups[0]?.groupId;
}

// ---- Consumer groups ---------------------------------------------------------

/** From `getGroupDetails` and `fetchGroupOffsets`: state, members, assignment and lag per partition, most lag first. */
export function groupContext(details: GroupDetails, offsets: GroupOffsetEntry[]): ContextSection[] {
  const total = offsets.reduce((sum, o) => sum + BigInt(o.lag), 0n);
  const byLag = [...offsets].sort((a, b) => compareBig(b.lag, a.lag));
  const owner = new Map<string, string>();
  for (const member of details.members) {
    for (const a of member.assignment) {
      for (const p of a.partitions) {
        owner.set(`${a.topic}/${p}`, member.clientId);
      }
    }
  }
  return [
    {
      title: `Consumer group ${details.groupId}`,
      priority: 90,
      text: [
        `- State: ${details.state}`,
        `- Protocol: ${details.protocolType || "none"} ${details.protocol}`.trimEnd(),
        `- Members: ${details.members.length}`,
        `- Total lag: ${total}`,
        `- Partitions committed: ${offsets.length}`,
      ].join("\n"),
    },
    {
      title: "Lag per partition (most first)",
      priority: 70,
      text: byLag.length
        ? capped(byLag, (o) => `- ${o.topic}/${o.partition}: committed ${o.offset}, end ${o.high}, lag ${o.lag}, consumer ${owner.get(`${o.topic}/${o.partition}`) ?? "unassigned"}`)
        : "No committed offsets",
      table: byLag.length
        ? table(
            ["Partition", "Committed", "End", "Lag", "Consumer"],
            byLag.map((o) => [`${o.topic}/${o.partition}`, o.offset, o.high, o.lag, owner.get(`${o.topic}/${o.partition}`) ?? "unassigned"]),
          )
        : undefined,
    },
    {
      title: "Members",
      priority: 50,
      text: details.members.length
        ? capped(details.members, (m) => `- ${m.clientId} on ${m.clientHost}: ${m.assignment.map((a) => `${a.topic}[${a.partitions.join(",")}]`).join(" ") || "nothing assigned"}`)
        : "No active members",
    },
  ];
}

/** Lag readings from the lag monitor, with Kafka Manager's own analysis. */
export function lagTrendContext(samples: LagSample[], trend: LagTrend, findings: LagFinding[], threshold?: bigint): ContextSection[] {
  return [
    {
      title: "Kafka Manager's lag analysis (rule-based)",
      priority: 95,
      text: [
        `- Trend over ${samples.length} reading(s): ${trend}`,
        threshold !== undefined ? `- Alert threshold: ${threshold}` : "",
        ...(findings.length ? findings.map((f) => `- ${f.text}`) : ["- No specific pattern detected."]),
      ]
        .filter(Boolean)
        .join("\n"),
    },
    {
      title: "Lag readings (oldest first)",
      priority: 60,
      text: formatHistory(samples),
    },
  ];
}

// ---- Topics ------------------------------------------------------------------

/** Partitions, ISR vs replicas, leader skew, non-default configs and Kafka Manager's risk rules. */
export function topicContext(details: TopicDetails, config: TopicConfigEntry[], risks?: ConfigRisk[]): ContextSection[] {
  const leaders = new Map<number, number>();
  for (const p of details.partitions) {
    leaders.set(p.leader, (leaders.get(p.leader) ?? 0) + 1);
  }
  const overrides = config.filter((c) => !c.isDefault && !c.isSensitive);
  const sections: ContextSection[] = [
    {
      title: `Topic ${details.name}`,
      priority: 90,
      text: [
        `- Partitions: ${details.partitions.length}, replication factor: ${details.replicationFactor}`,
        `- Under-replicated: ${details.underReplicated}, offline: ${details.offline}`,
        `- Messages retained: ${details.messageCount}`,
        `- Leaders per broker: ${[...leaders].map(([b, n]) => `${b}=${n}`).join(", ") || "none"}`,
      ].join("\n"),
    },
    {
      title: "Non-default configs",
      priority: 70,
      text: overrides.length ? capped(overrides, (c) => `- ${c.name}=${c.value}${c.isTopicOverride ? " (set on topic)" : ""}`, 60) : "None",
      table: overrides.length ? table(["Setting", "Value", "Source"], overrides.map((c) => [c.name, c.value, c.isTopicOverride ? "topic" : "broker"])) : undefined,
    },
    {
      title: "Partitions",
      priority: 30,
      text: capped(details.partitions, (p) => `- ${p.partitionId}: leader ${p.leader}, replicas [${p.replicas.join(",")}], ISR [${p.isr.join(",")}], ${p.messageCount} messages`),
      table: table(
        ["Partition", "Leader", "Replicas", "ISR", "Messages"],
        details.partitions.map((p) => [String(p.partitionId), String(p.leader), p.replicas.join(","), p.isr.join(","), p.messageCount]),
      ),
    },
  ];
  if (risks) {
    sections.splice(1, 0, riskSection(risks));
  }
  return sections;
}

export function riskSection(risks: ConfigRisk[]): ContextSection {
  return {
    title: "Kafka Manager's config checks (rule-based)",
    priority: 85,
    text: formatRisks(risks),
    table: risks.length ? table(["Level", "Setting", "Finding"], risks.map((r) => [r.level, r.setting, r.text])) : undefined,
  };
}

// ---- Brokers -----------------------------------------------------------------

/** From `getBrokerDetails`: role, load, rack and settings that aren't defaults. */
export function brokerContext(details: BrokerDetails, risks?: ConfigRisk[]): ContextSection[] {
  const notable = details.config.filter((c) => !c.isDefault && !c.isSensitive && c.value !== null);
  const sections: ContextSection[] = [
    {
      title: `Broker ${details.nodeId}`,
      priority: 90,
      text: [
        `- Address: ${details.host}:${details.port}`,
        `- Role: ${details.isController ? "controller" : "broker"}`,
        `- Rack: ${details.rack ?? "not set"}`,
        `- Leads ${details.leaderCount} partitions, hosts ${details.replicaCount} replicas`,
      ].join("\n"),
    },
    {
      title: "Non-default broker settings",
      priority: 60,
      text: notable.length ? capped(notable, (c) => `- ${c.name}=${c.value} (${c.source})`, 80) : "None",
      table: notable.length ? table(["Setting", "Value", "Source"], notable.map((c) => [c.name, c.value ?? "", c.source])) : undefined,
    },
  ];
  if (risks) {
    sections.splice(1, 0, riskSection(risks));
  }
  return sections;
}

export function aclContext(acls: AclEntry[]): ContextSection {
  return {
    title: `ACLs (${acls.length})`,
    priority: 40,
    text: acls.length
      ? capped(acls, (a) => `- ${a.permission} ${a.operation} on ${a.resourceType} ${a.resourceName} (${a.patternType}) for ${a.principal}@${a.host}`, 60)
      : "No ACLs (or the cluster has no authorizer).",
  };
}

// ---- Errors ------------------------------------------------------------------

/**
 * The last connection failure: the whole `cause` chain, the security mode
 * (TLS/SASL mechanism only) and Kafka Manager's own heuristic hint.
 */
export function errorContext(
  cluster: ClusterConfig,
  lastError: string | undefined,
  chain: ErrorLink[],
  hint: string | undefined,
): ContextSection[] {
  if (!lastError && chain.length === 0) {
    return [{ title: "Last connection error", priority: 95, text: "No connection error recorded for this cluster." }];
  }
  const links = chain.length
    ? chain.map((e, i) => `${"  ".repeat(i)}- ${e.name || "Error"}: ${e.message}${e.code ? ` [${e.code}]` : ""}${e.broker ? ` (broker ${e.broker})` : ""}`).join("\n")
    : `- ${lastError}`;
  return [
    {
      title: "Last connection error",
      priority: 95,
      text: [`- Error: ${lastError ?? chain[0]?.message}`, `- Security mode: ${securityLabel(cluster)}`, hint ? `- Kafka Manager's own guess: ${hint}` : "- Kafka Manager's rules found no specific cause."].join("\n"),
    },
    { title: "Error cause chain (outermost first)", priority: 80, text: links },
  ];
}

// ---- Messages ----------------------------------------------------------------

/** Evenly spread sample of up to `n` messages, newest first order kept. */
export function sampleMessages<T>(messages: T[], n: number): T[] {
  if (messages.length <= n) {
    return messages.slice();
  }
  if (n <= 0) {
    return [];
  }
  const step = messages.length / n;
  return Array.from({ length: n }, (_, i) => messages[Math.floor(i * step)]);
}

/** One message (payload truncated), for explaining it or its decode error. */
export function messageContext(topic: string, message: ConsumedMessage, maxChars = MAX_PAYLOAD_CHARS): ContextSection {
  const headers = Object.entries(message.headers ?? {});
  const schema = (s: ConsumedMessage["valueSchema"]) => (s ? `schema id ${s.id}${s.subject ? `, ${s.subject}` : ""}, ${s.type}` : "");
  return {
    title: `Message ${topic}/${message.partition} @ offset ${message.offset}`,
    priority: 90,
    text: [
      `- Timestamp: ${message.timestamp ? new Date(Number(message.timestamp)).toISOString() : "unknown"}`,
      `- Key (${message.keyEncoding ?? "utf-8"}${message.keySchema ? `, ${schema(message.keySchema)}` : ""}): ${message.key === null ? "null" : truncatePayload(message.key, Math.min(maxChars, 500))}`,
      `- Headers: ${headers.length ? headers.map(([k, v]) => `${k}=${truncatePayload(v, 200)}`).join(", ") : "none"}`,
      `- Value format: ${message.valueEncoding ?? "utf-8"}${message.valueSchema ? ` (${schema(message.valueSchema)})` : ""}, ${message.size ?? "?"} bytes`,
      message.decodeError ? `- Decode error: ${message.decodeError}` : "",
      "- Value:",
      "```",
      message.value === null ? "null" : truncatePayload(message.value, maxChars),
      "```",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  };
}

/** A sample of messages for schema inference: keys, values (truncated) and formats. */
export function messagesContext(topic: string, messages: ConsumedMessage[], n = 20, maxChars = 800): ContextSection {
  const sample = sampleMessages(messages, n);
  const formats = [...new Set(sample.map((m) => m.valueEncoding ?? "utf-8"))].join(", ");
  return {
    title: `${sample.length} sampled message(s) from ${topic}`,
    priority: 90,
    text: [
      `- Value formats seen: ${formats || "none"}`,
      `- Messages with a key: ${sample.filter((m) => m.key !== null && m.key !== "").length} of ${sample.length}`,
      ...sample.map(
        (m) =>
          `\n### partition ${m.partition}, offset ${m.offset}\nkey: ${m.key === null ? "null" : truncatePayload(m.key, 200)}\n\`\`\`\n${m.value === null ? "null" : truncatePayload(m.value, maxChars)}\n\`\`\``,
      ),
    ].join("\n"),
  };
}
