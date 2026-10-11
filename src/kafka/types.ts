export type PasswordSaslMechanism = "plain" | "scram-sha-256" | "scram-sha-512";

/** Passwords are never stored here; they live in VS Code's SecretStorage, keyed by cluster id. */
export type ClusterSasl =
  | { mechanism: PasswordSaslMechanism; username: string }
  | {
      mechanism: "aws-iam";
      region: string;
      /** AWS profile to sign with; the default credential chain when omitted. */
      profile?: string;
    };

export interface ClusterSsl {
  /** PEM file with the CA that signed the broker certificates; system CAs when omitted. */
  caFile?: string;
  /** Set to false to accept self-signed/untrusted certificates (dev clusters only). */
  rejectUnauthorized?: boolean;
  /** PEM client certificate for mutual TLS (e.g. Aiven); used together with `keyFile`. */
  certFile?: string;
  /** PEM private key for `certFile`. Must not be passphrase-protected. */
  keyFile?: string;
}

export interface ClusterConfig {
  id: string;
  name: string;
  brokers: string[];
  /** TLS to the brokers: `true` for system CAs, an object for a custom CA or no verification. */
  ssl?: boolean | ClusterSsl;
  sasl?: ClusterSasl;
  /** Confluent-compatible Schema Registry used to decode Avro/Protobuf/JSON Schema payloads. */
  schemaRegistry?: ClusterSchemaRegistry;
}

export interface ClusterSchemaRegistry {
  url: string;
  /** Basic-auth user (Confluent Cloud: the Schema Registry API key). The password lives in SecretStorage. */
  username?: string;
}

/** Which settings file a cluster was read from. Workspace clusters can be committed and shared. */
export type ClusterSource = "user" | "workspace";

/** Connection security chosen in the Add Cluster / Edit Connection Security flows. */
export interface ClusterSecurity {
  ssl?: boolean | ClusterSsl;
  sasl?: ClusterSasl;
  /** New SASL password; undefined keeps whatever is already stored. */
  password?: string;
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

export type MessageFormat =
  | "auto"
  | "string"
  | "json"
  | "avro"
  | "protobuf"
  | "json-schema"
  | "hex"
  | "base64";

export interface SchemaInfo {
  id: number;
  type: "AVRO" | "PROTOBUF" | "JSON" | "UNKNOWN";
  /** "subject vN", when the registry can map the id back to a subject. */
  subject?: string;
}

export interface ConsumedMessage {
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  timestamp: string;
  headers: Record<string, string>;
  /** Raw value size in bytes. */
  size?: number;
  /** How key/value were turned into text, e.g. "utf-8", "avro", "base64". */
  keyEncoding?: string;
  valueEncoding?: string;
  keySchema?: SchemaInfo;
  valueSchema?: SchemaInfo;
  /** Why the requested format couldn't be applied. */
  decodeError?: string;
}

/** Where a browse starts on each partition. `before`/`after` page from offsets already loaded. */
export type StartPosition =
  | { kind: "newest" }
  | { kind: "oldest" }
  | { kind: "offset"; offset: string }
  | { kind: "timestamp"; timestamp: number }
  | { kind: "before"; offsets: Record<number, string> }
  | { kind: "after"; offsets: Record<number, string> };

export interface BrowseRequest {
  position: StartPosition;
  /** Messages per partition (or matches in total, when searching). */
  limit: number;
  /** Only this partition; all when omitted. */
  partition?: number;
  /** Keep only messages whose key, value or headers contain this text. */
  search?: string;
  /** With `search`: how many offsets per partition to scan at most. */
  scanLimit?: number;
  format?: { key: MessageFormat; value: MessageFormat };
}

export interface BrowseResult {
  messages: ConsumedMessage[];
  /** Messages read, including those the search filtered out. */
  scanned: number;
  /** True when stopped early by cancellation, the match limit, or the time limit. */
  truncated: boolean;
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

export interface BrokerConfigEntry {
  name: string;
  value: string | null;
  isDefault: boolean;
  readOnly: boolean;
  isSensitive: boolean;
  /** e.g. "static", "dynamic", "default". */
  source: string;
}

export interface BrokerDetails extends BrokerSummary {
  rack?: string;
  config: BrokerConfigEntry[];
}

export interface AclEntry {
  resourceType: string;
  resourceName: string;
  patternType: string;
  principal: string;
  host: string;
  operation: string;
  permission: string;
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
  /** Set on the topic itself, as opposed to inherited from the broker or a default. */
  isTopicOverride: boolean;
}

export interface ProduceOptions {
  key?: string;
  value: string;
  partition?: number;
  headers?: Record<string, string>;
  /** Encode the value (parsed as JSON) with the latest schema of this Schema Registry subject. */
  valueSubject?: string;
}

/** A saved produce form. Key, value and header values may contain {{variables}}. */
export interface ProduceTemplate {
  name: string;
  key: string;
  value: string;
  headers: Record<string, string>;
  partition: number | null;
  valueSubject?: string;
}

export interface LagAlert {
  /** Cluster id or name. */
  cluster: string;
  group: string;
  /** Total lag (messages) that triggers the alert. */
  threshold: number;
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
