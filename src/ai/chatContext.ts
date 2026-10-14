import { securityLabel } from "../kafka/connectionConfig";
import {
  ClusterConfig,
  ClusterOverview,
  ConnectionStatus,
  GroupDetails,
  GroupOffsetEntry,
  TopicConfigEntry,
  TopicDetails,
} from "../kafka/types";
import { ContextSection } from "./budget";

/** Rows shown before a list is summarised as "…and N more". */
const MAX_ROWS = 25;

export interface ChatTarget {
  cluster?: ClusterConfig;
  /** The prompt with the cluster name taken out. */
  rest: string;
  /** Why this cluster was picked, when it wasn't named. */
  note?: string;
}

/**
 * Which cluster a chat request is about: one named in the prompt (longest
 * name wins), else the only/first connected one, else the only one configured.
 */
export function resolveChatTarget(
  prompt: string,
  clusters: ClusterConfig[],
  status: (id: string) => ConnectionStatus,
): ChatTarget {
  const text = prompt.trim();
  const named = [...clusters]
    .sort((a, b) => b.name.length - a.name.length)
    .find((c) => new RegExp(`(^|\\s)${escapeRegExp(c.name)}(?=\\s|$|[?.,!])`, "i").test(text));
  if (named) {
    const rest = text.replace(new RegExp(`(^|\\s)${escapeRegExp(named.name)}(?=\\s|$|[?.,!])`, "i"), " ").trim();
    return { cluster: named, rest };
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The longest of `names` that appears in `text` as a whole word, e.g. a group or topic. */
export function findMentioned(text: string, names: string[]): string | undefined {
  return [...names]
    .sort((a, b) => b.length - a.length)
    .find((name) => new RegExp(`(^|[\\s\`'"])${escapeRegExp(name)}(?=$|[\\s\`'"?.,!:])`, "i").test(text));
}

function capped<T>(rows: T[], line: (row: T) => string): string {
  const shown = rows.slice(0, MAX_ROWS).map(line);
  if (rows.length > MAX_ROWS) {
    shown.push(`- …and ${rows.length - MAX_ROWS} more`);
  }
  return shown.join("\n");
}

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

export function overviewSections(overview: ClusterOverview): ContextSection[] {
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
    },
  ];
  const unhealthy = overview.topics.filter((topic) => topic.underReplicated > 0 || topic.offline > 0);
  if (unhealthy.length > 0) {
    sections.push({
      title: "Topics with partition problems",
      priority: 80,
      text: capped(unhealthy, (topic) => `- ${topic.name}: ${topic.underReplicated} under-replicated, ${topic.offline} offline, RF ${topic.replicationFactor}`),
    });
  }
  const lagging = [...overview.groups].sort((a, b) => compareBig(b.totalLag, a.totalLag));
  sections.push(
    {
      title: "Consumer groups (most lag first)",
      priority: 70,
      text: lagging.length ? capped(lagging, (g) => `- ${g.groupId}: ${g.state}, ${g.memberCount} members, lag ${g.totalLag}, topics ${g.topics.join(", ") || "none"}`) : "None",
    },
    {
      title: "Topics",
      priority: 20,
      text: capped(overview.topics, (topic) => `- ${topic.name}: ${topic.partitionCount} partitions, RF ${topic.replicationFactor}, ${topic.messageCount} messages`),
    },
  );
  return sections;
}

export function groupSections(details: GroupDetails, offsets: GroupOffsetEntry[]): ContextSection[] {
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

export function topicSections(details: TopicDetails, config: TopicConfigEntry[]): ContextSection[] {
  const leaders = new Map<number, number>();
  for (const p of details.partitions) {
    leaders.set(p.leader, (leaders.get(p.leader) ?? 0) + 1);
  }
  const overrides = config.filter((c) => !c.isDefault && !c.isSensitive);
  return [
    {
      title: `Topic ${details.name}`,
      priority: 90,
      text: [
        `- Partitions: ${details.partitions.length}, replication factor: ${details.replicationFactor}`,
        `- Under-replicated: ${details.underReplicated}, offline: ${details.offline}`,
        `- Messages retained: ${details.messageCount}`,
        `- Leaders per broker: ${[...leaders].map(([b, n]) => `${b}=${n}`).join(", ")}`,
      ].join("\n"),
    },
    {
      title: "Non-default configs",
      priority: 70,
      text: overrides.length ? capped(overrides, (c) => `- ${c.name}=${c.value}${c.isTopicOverride ? " (set on topic)" : ""}`) : "None",
    },
    {
      title: "Partitions",
      priority: 30,
      text: capped(details.partitions, (p) => `- ${p.partitionId}: leader ${p.leader}, replicas [${p.replicas.join(",")}], ISR [${p.isr.join(",")}], ${p.messageCount} messages`),
    },
  ];
}

export function errorSection(lastError: string | undefined, hint: string | undefined): ContextSection {
  return {
    title: "Last connection error",
    priority: 95,
    text: lastError
      ? `- Error: ${lastError}${hint ? `\n- Kafka Manager's own guess: ${hint}` : ""}`
      : "No connection error recorded for this cluster.",
  };
}

function compareBig(a: string, b: string): number {
  const x = BigInt(a || "0");
  const y = BigInt(b || "0");
  return x < y ? -1 : x > y ? 1 : 0;
}
