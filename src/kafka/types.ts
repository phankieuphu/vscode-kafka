export interface ClusterConfig {
  id: string;
  name: string;
  brokers: string[];
}

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface PartitionInfo {
  partitionId: number;
  leader: number;
  replicas: number[];
  isr: number[];
}

export interface TopicInfo {
  name: string;
  partitions: PartitionInfo[];
}

export interface GroupOffsetEntry {
  topic: string;
  partition: number;
  offset: string;
  low: string;
  high: string;
  lag: string;
}

export interface ConsumedMessage {
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  timestamp: string;
  headers: Record<string, string>;
}

export interface GroupMemberAssignment {
  topic: string;
  partitions: number[];
}

export interface GroupMemberInfo {
  memberId: string;
  clientId: string;
  clientHost: string;
  assignment: GroupMemberAssignment[];
}

export interface GroupDetails {
  groupId: string;
  state: string;
  protocol: string;
  protocolType: string;
  members: GroupMemberInfo[];
}

export interface BrokerSummary {
  nodeId: number;
  host: string;
  port: number;
  isController: boolean;
  /** Partitions this broker currently leads. */
  leaderCount: number;
  /** Partition replicas hosted on this broker (leader or follower). */
  replicaCount: number;
}

export interface TopicSummary {
  name: string;
  partitionCount: number;
  replicationFactor: number;
  underReplicated: number;
  offline: number;
  /** Sum of (high - low) watermarks across partitions; a string because it can exceed 2^53. */
  messageCount: string;
}

export interface GroupSummary {
  groupId: string;
  state: string;
  memberCount: number;
  topics: string[];
  /** Sum of lag over every committed partition; a string because it can exceed 2^53. */
  totalLag: string;
}

export interface ClusterOverview {
  clusterId: string;
  controllerId: number | null;
  brokers: BrokerSummary[];
  topics: TopicSummary[];
  groups: GroupSummary[];
  totals: {
    brokers: number;
    topics: number;
    partitions: number;
    underReplicated: number;
    offline: number;
    groups: number;
    totalLag: string;
  };
}

export interface PartitionDetail extends PartitionInfo {
  low: string;
  high: string;
  messageCount: string;
}

export interface TopicDetails {
  name: string;
  partitions: PartitionDetail[];
  replicationFactor: number;
  underReplicated: number;
  offline: number;
  messageCount: string;
}

export interface TopicConfigEntry {
  name: string;
  value: string;
  isDefault: boolean;
  readOnly: boolean;
  isSensitive: boolean;
}

export interface ProduceOptions {
  key?: string;
  value: string;
  partition?: number;
  headers?: Record<string, string>;
}

export type ResetSpec =
  | { mode: "earliest" | "latest" }
  | { mode: "timestamp"; timestamp: number }
  | { mode: "shift"; by: number };

export interface OffsetMove {
  partition: number;
  from: string;
  to: string;
}
