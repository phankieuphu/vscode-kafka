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
  high: string;
  lag: string;
}

export interface ConsumedMessage {
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  timestamp: string;
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
