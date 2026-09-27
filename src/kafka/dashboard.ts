import {
  BrokerSummary,
  ClusterOverview,
  GroupSummary,
  TopicInfo,
  TopicSummary,
} from "./types";

export interface RawBroker {
  nodeId: number;
  host: string;
  port: number;
}

export interface RawWatermark {
  partition: number;
  high: string;
  low: string;
}

export interface RawGroup {
  groupId: string;
  state: string;
  memberCount: number;
  /** Committed offsets per topic, as returned by `admin.fetchOffsets({ groupId })`. */
  offsets: { topic: string; partitions: { partition: number; offset: string }[] }[];
}

export interface RawClusterSnapshot {
  clusterId: string;
  controllerId: number | null;
  brokers: RawBroker[];
  topics: TopicInfo[];
  /** Watermarks keyed by topic name. Topics missing here count as empty. */
  watermarks: Map<string, RawWatermark[]>;
  groups: RawGroup[];
}

/**
 * Pure aggregation from raw admin responses into the dashboard model. Kept free
 * of KafkaJS and VS Code so it can be unit-tested without a broker.
 */
export function buildClusterOverview(raw: RawClusterSnapshot): ClusterOverview {
  const leaderCounts = new Map<number, number>();
  const replicaCounts = new Map<number, number>();

  const topics: TopicSummary[] = raw.topics.map((topic) => {
    let underReplicated = 0;
    let offline = 0;
    let replicationFactor = 0;
    for (const p of topic.partitions) {
      replicationFactor = Math.max(replicationFactor, p.replicas.length);
      if (p.leader < 0) {
        offline++;
      } else {
        leaderCounts.set(p.leader, (leaderCounts.get(p.leader) ?? 0) + 1);
      }
      if (p.isr.length < p.replicas.length) {
        underReplicated++;
      }
      for (const r of p.replicas) {
        replicaCounts.set(r, (replicaCounts.get(r) ?? 0) + 1);
      }
    }
    let messages = 0n;
    for (const w of raw.watermarks.get(topic.name) ?? []) {
      const diff = BigInt(w.high) - BigInt(w.low);
      if (diff > 0n) {
        messages += diff;
      }
    }
    return {
      name: topic.name,
      partitionCount: topic.partitions.length,
      replicationFactor,
      underReplicated,
      offline,
      messageCount: messages.toString(),
    };
  });

  const brokers: BrokerSummary[] = raw.brokers
    .map((b) => ({
      nodeId: b.nodeId,
      host: b.host,
      port: b.port,
      isController: b.nodeId === raw.controllerId,
      leaderCount: leaderCounts.get(b.nodeId) ?? 0,
      replicaCount: replicaCounts.get(b.nodeId) ?? 0,
    }))
    .sort((a, b) => a.nodeId - b.nodeId);

  let clusterLag = 0n;
  const groups: GroupSummary[] = raw.groups
    .map((group) => {
      let lag = 0n;
      const topicNames: string[] = [];
      for (const { topic, partitions } of group.offsets) {
        topicNames.push(topic);
        const marks = raw.watermarks.get(topic) ?? [];
        for (const p of partitions) {
          const high = BigInt(marks.find((m) => m.partition === p.partition)?.high ?? "0");
          // Matches ClusterManager.fetchGroupOffsets: no commit means the whole partition is lag.
          const partitionLag = p.offset === "-1" ? high : high - BigInt(p.offset);
          if (partitionLag > 0n) {
            lag += partitionLag;
          }
        }
      }
      clusterLag += lag;
      return {
        groupId: group.groupId,
        state: group.state,
        memberCount: group.memberCount,
        topics: topicNames.sort(),
        totalLag: lag.toString(),
      };
    })
    .sort((a, b) => a.groupId.localeCompare(b.groupId));

  return {
    clusterId: raw.clusterId,
    controllerId: raw.controllerId,
    brokers,
    topics,
    groups,
    totals: {
      brokers: brokers.length,
      topics: topics.length,
      partitions: topics.reduce((sum, t) => sum + t.partitionCount, 0),
      underReplicated: topics.reduce((sum, t) => sum + t.underReplicated, 0),
      offline: topics.reduce((sum, t) => sum + t.offline, 0),
      groups: groups.length,
      totalLag: clusterLag.toString(),
    },
  };
}

export interface ClusterIssue {
  level: "crit" | "warn";
  kind: "cluster" | "topic" | "group";
  name?: string;
  text: string;
}

export function listIssues(overview: ClusterOverview): ClusterIssue[] {
  const issues: ClusterIssue[] = [];
  if (overview.controllerId === null) {
    issues.push({ level: "crit", kind: "cluster", text: "No active controller" });
  }
  for (const t of overview.topics) {
    if (t.offline > 0) {
      issues.push({ level: "crit", kind: "topic", name: t.name, text: `${t.offline} offline partition${t.offline === 1 ? "" : "s"} in` });
    }
  }
  for (const t of overview.topics) {
    if (t.underReplicated > 0) {
      issues.push({ level: "warn", kind: "topic", name: t.name, text: `${t.underReplicated} under-replicated partition${t.underReplicated === 1 ? "" : "s"} in` });
    }
  }
  for (const g of overview.groups) {
    if (g.state === "Empty" && BigInt(g.totalLag) > 0n) {
      issues.push({ level: "warn", kind: "group", name: g.groupId, text: "has lag but no members" });
    }
  }
  return issues;
}
