import { BrokerConfigEntry, BrokerSummary, TopicConfigEntry } from "./types";

export type RiskLevel = "crit" | "warn" | "info";

/** A configuration problem found by rule, which the AI then only explains. */
export interface ConfigRisk {
  level: RiskLevel;
  /** The setting (or "layout") the finding is about. */
  setting: string;
  text: string;
}

const ORDER: Record<RiskLevel, number> = { crit: 0, warn: 1, info: 2 };

function sortRisks(risks: ConfigRisk[]): ConfigRisk[] {
  return risks.sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.setting.localeCompare(b.setting));
}

function valueOf(config: Array<{ name: string; value: string | null }>, name: string): string | undefined {
  const v = config.find((c) => c.name === name)?.value;
  return v === null || v === undefined ? undefined : String(v);
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export interface TopicFacts {
  replicationFactor: number;
  partitions: Array<{ leader: number }>;
  underReplicated: number;
  offline: number;
  /** Retained messages; a string because it can exceed 2^53. */
  messageCount: string;
  /** Brokers in the cluster, when known, for leader skew. */
  brokerCount?: number;
  /** Whether sampled messages had keys: false = none had one; undefined = not sampled. */
  keysSeen?: boolean;
}

const HOUR_MS = 3_600_000;
const HIGH_VOLUME = 1_000_000n;

/** Risky settings and layout of one topic, most severe first. */
export function topicConfigRisks(facts: TopicFacts, config: TopicConfigEntry[]): ConfigRisk[] {
  const risks: ConfigRisk[] = [];
  const rf = facts.replicationFactor;
  const minIsr = num(valueOf(config, "min.insync.replicas"));
  const cleanup = valueOf(config, "cleanup.policy") ?? "delete";
  const retentionMs = num(valueOf(config, "retention.ms"));
  const retentionBytes = num(valueOf(config, "retention.bytes"));
  let messages = 0n;
  try {
    messages = BigInt(facts.messageCount || "0");
  } catch {
    messages = 0n;
  }

  if (facts.offline > 0) {
    risks.push({ level: "crit", setting: "layout", text: `${facts.offline} partition(s) have no leader: reads and writes to them fail.` });
  }
  if (facts.underReplicated > 0) {
    risks.push({ level: "warn", setting: "layout", text: `${facts.underReplicated} partition(s) are under-replicated (ISR smaller than the replica set).` });
  }
  if (rf === 1) {
    risks.push({ level: "warn", setting: "replication.factor", text: "Replication factor 1: losing that one broker makes the data unavailable, or loses it." });
  }
  if (minIsr !== undefined && rf > 0) {
    if (minIsr > rf) {
      risks.push({ level: "crit", setting: "min.insync.replicas", text: `min.insync.replicas=${minIsr} is above the replication factor ${rf}: producers with acks=all always fail (NotEnoughReplicas).` });
    } else if (minIsr === rf && rf > 1) {
      risks.push({ level: "warn", setting: "min.insync.replicas", text: `min.insync.replicas=${minIsr} equals the replication factor: one broker down or restarting blocks every acks=all write.` });
    } else if (minIsr === 1 && rf >= 3) {
      risks.push({ level: "info", setting: "min.insync.replicas", text: `min.insync.replicas=1 with replication factor ${rf}: acks=all only guarantees one copy. 2 is the usual choice.` });
    }
  }
  if (valueOf(config, "unclean.leader.election.enable") === "true") {
    risks.push({ level: "warn", setting: "unclean.leader.election.enable", text: "Unclean leader election is on: an out-of-sync replica can become leader and committed messages can be lost." });
  }
  const deletes = /delete/.test(cleanup);
  if (deletes && retentionMs === -1 && (retentionBytes === undefined || retentionBytes === -1)) {
    risks.push({
      level: messages >= HIGH_VOLUME ? "warn" : "info",
      setting: "retention.ms",
      text: `retention.ms=-1 with no size limit: the topic is never cleaned up${messages >= HIGH_VOLUME ? ` and already holds ${messages.toLocaleString()} messages` : ""}; disk use only grows.`,
    });
  }
  if (deletes && retentionMs !== undefined && retentionMs > 0 && retentionMs < HOUR_MS) {
    risks.push({ level: "info", setting: "retention.ms", text: `retention.ms=${retentionMs} (under an hour): a consumer that falls behind briefly can lose messages to retention.` });
  }
  if (/compact/.test(cleanup) && facts.keysSeen === false) {
    risks.push({ level: "warn", setting: "cleanup.policy", text: "cleanup.policy includes compact, but none of the sampled messages has a key. Compaction keeps the latest value per key; brokers reject keyless messages on compacted topics." });
  }
  const segmentMs = num(valueOf(config, "segment.ms"));
  if (segmentMs !== undefined && segmentMs > 0 && segmentMs < HOUR_MS) {
    risks.push({ level: "info", setting: "segment.ms", text: `segment.ms=${segmentMs}: very small segments mean many files and open handles on the brokers.` });
  }
  const maxBytes = num(valueOf(config, "max.message.bytes"));
  if (maxBytes !== undefined && maxBytes > 10 * 1024 * 1024) {
    risks.push({ level: "info", setting: "max.message.bytes", text: `max.message.bytes=${maxBytes}: consumers' fetch.max.bytes / max.partition.fetch.bytes must be at least this large.` });
  }
  if ((facts.brokerCount ?? 0) > 1 && facts.partitions.length >= 4) {
    const leaders = new Map<number, number>();
    for (const p of facts.partitions) {
      leaders.set(p.leader, (leaders.get(p.leader) ?? 0) + 1);
    }
    const [broker, count] = [...leaders].sort((a, b) => b[1] - a[1])[0] ?? [-1, 0];
    if (count / facts.partitions.length > 0.6 && leaders.size < (facts.brokerCount ?? 0)) {
      risks.push({ level: "warn", setting: "layout", text: `Broker ${broker} leads ${count} of ${facts.partitions.length} partitions: that broker takes most of this topic's load. Consider a preferred leader election or reassignment.` });
    }
  }
  return sortRisks(risks);
}

/** Risky broker settings and cluster layout, most severe first. */
export function brokerConfigRisks(config: BrokerConfigEntry[], brokers: BrokerSummary[], rack?: string): ConfigRisk[] {
  const risks: ConfigRisk[] = [];
  const count = brokers.length;
  const defaultRf = num(valueOf(config, "default.replication.factor"));
  const offsetsRf = num(valueOf(config, "offsets.topic.replication.factor"));
  const minIsr = num(valueOf(config, "min.insync.replicas"));

  if (valueOf(config, "unclean.leader.election.enable") === "true") {
    risks.push({ level: "warn", setting: "unclean.leader.election.enable", text: "Unclean leader election is on for the broker: committed messages can be lost on failover." });
  }
  if (count > 1 && defaultRf === 1) {
    risks.push({ level: "warn", setting: "default.replication.factor", text: "default.replication.factor=1 on a multi-broker cluster: auto-created topics have no redundancy." });
  }
  if (count >= 3 && offsetsRf !== undefined && offsetsRf < 3) {
    risks.push({ level: "warn", setting: "offsets.topic.replication.factor", text: `offsets.topic.replication.factor=${offsetsRf}: consumer group offsets are at risk if a broker fails.` });
  }
  if (count >= 3 && minIsr === 1 && (defaultRf ?? 1) >= 3) {
    risks.push({ level: "info", setting: "min.insync.replicas", text: "min.insync.replicas=1 by default: acks=all only guarantees one copy unless topics override it." });
  }
  if (valueOf(config, "auto.create.topics.enable") === "true") {
    risks.push({ level: "info", setting: "auto.create.topics.enable", text: "Topics are auto-created on first use: a typo in a topic name silently creates a new topic with default settings." });
  }
  if (count > 1) {
    const total = brokers.reduce((s, b) => s + b.leaderCount, 0);
    const avg = total / count;
    for (const b of brokers) {
      if (total >= count * 2 && b.leaderCount > avg * 1.5) {
        risks.push({ level: "warn", setting: "layout", text: `Broker ${b.nodeId} leads ${b.leaderCount} partitions, ${(b.leaderCount / avg).toFixed(1)}× the average: leadership is unbalanced.` });
      }
    }
    if (!rack) {
      risks.push({ level: "info", setting: "broker.rack", text: "No broker.rack set: replicas aren't spread across racks or availability zones." });
    }
  }
  return sortRisks(risks);
}

export function formatRisks(risks: ConfigRisk[]): string {
  if (risks.length === 0) {
    return "No risky settings found by Kafka Manager's rules.";
  }
  const label: Record<RiskLevel, string> = { crit: "CRITICAL", warn: "WARNING", info: "NOTE" };
  return risks.map((r) => `- ${label[r.level]} ${r.setting}: ${r.text}`).join("\n");
}
