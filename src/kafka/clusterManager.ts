import * as crypto from "crypto";
import * as vscode from "vscode";
import {
  Admin,
  AssignerProtocol,
  ConfigResourceTypes,
  IHeaders,
  Kafka,
  GroupOverview,
  ITopicMetadata,
  Producer,
  KafkaJSNumberOfRetriesExceeded,
  KafkaJSConnectionError,
  KafkaJSRequestTimeoutError,
  KafkaJSBrokerNotFound,
} from "kafkajs";
import {
  buildKafkaConfig,
  connectionKey,
  needsPassword,
} from "./connectionConfig";
import { explainConnectionError } from "./connectionHints";
import { buildClusterOverview, RawGroup, RawWatermark } from "./dashboard";
import { planReset } from "./offsets";
import {
  ClusterConfig,
  ClusterOverview,
  ClusterSecurity,
  ConnectionStatus,
  ConsumedMessage,
  GroupDetails,
  GroupOffsetEntry,
  OffsetMove,
  PartitionInfo,
  ProduceOptions,
  ResetSpec,
  TopicConfigEntry,
  TopicDetails,
  TopicInfo,
} from "./types";

const CONFIG_SECTION = "kafka";
const CONFIG_CLUSTERS_KEY = "clusters";
const PASSWORD_SECRET_PREFIX = "kafka-manager.password.";

function toTopicInfo(metadata: ITopicMetadata): TopicInfo {
  const partitions: PartitionInfo[] = metadata.partitions
    .slice()
    .sort((a, b) => a.partitionId - b.partitionId)
    .map((p) => ({
      partitionId: p.partitionId,
      leader: p.leader,
      replicas: p.replicas,
      isr: p.isr,
    }));
  return { name: metadata.name, partitions };
}

function decodeHeaders(headers: IHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers ?? {})) {
    const values = Array.isArray(raw) ? raw : [raw];
    result[name] = values
      .filter((v) => v !== undefined)
      .map((v) => v!.toString())
      .join(", ");
  }
  return result;
}

/**
 * Owns cluster configuration (persisted in the `kafka.clusters` setting),
 * live connection state, and every KafkaJS admin/producer/consumer operation
 * used by the tree view and topic panels.
 */
export class ClusterManager implements vscode.Disposable {
  private readonly statuses = new Map<string, ConnectionStatus>();
  private readonly kafkaInstances = new Map<string, Kafka>();
  /** connectionKey() of the config each cached Kafka instance was built from. */
  private readonly connectionKeys = new Map<string, string>();
  private readonly admins = new Map<string, Admin>();
  private readonly lastErrors = new Map<string, string>();
  private readonly lastHints = new Map<string, string>();
  private readonly configListener: vscode.Disposable;
  private readonly output = vscode.window.createOutputChannel("Kafka Manager");

  private readonly _onDidChangeStatus = new vscode.EventEmitter<string>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private readonly _onDidChangeClusters = new vscode.EventEmitter<void>();
  readonly onDidChangeClusters = this._onDidChangeClusters.event;

  private readonly producers = new Map<string, Promise<Producer>>();

  private readonly _onDidLoseConnection =
    new vscode.EventEmitter<ClusterConfig>();
  readonly onDidLoseConnection = this._onDidLoseConnection.event;

  /** `secrets` holds SASL passwords; without it (tests) passwords can't be saved. */
  constructor(private readonly secrets?: vscode.SecretStorage) {
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_CLUSTERS_KEY}`)) {
        void this.applyConfigChanges();
      }
    });
  }

  /** Hand edits to brokers/ssl/sasl in settings.json rebuild the client instead of silently keeping the old one. */
  private async applyConfigChanges(): Promise<void> {
    for (const [id, key] of [...this.connectionKeys]) {
      const cluster = this.getCluster(id);
      if (cluster && connectionKey(cluster) === key) {
        continue;
      }
      const wasConnected = await this.dropClient(id);
      if (cluster && wasConnected) {
        this.log(`Connection settings for "${cluster.name}" changed; reconnecting.`);
        this.connect(cluster).catch(() => undefined);
      }
    }
  }

  /** Forgets the cached client (and its producer/admin) so the next use rebuilds it from the current config. */
  private async dropClient(id: string): Promise<boolean> {
    const wasConnected = this.getStatus(id) === "connected";
    this.kafkaInstances.delete(id);
    this.connectionKeys.delete(id);
    const producer = this.producers.get(id);
    if (producer) {
      this.producers.delete(id);
      producer.then((p) => p.disconnect()).catch(() => undefined);
    }
    if (this.admins.has(id) || this.getStatus(id) !== "disconnected") {
      await this.disconnect(id);
    }
    return wasConnected;
  }

  getClusters(): ClusterConfig[] {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<ClusterConfig[]>(CONFIG_CLUSTERS_KEY, []);
  }

  getCluster(id: string): ClusterConfig | undefined {
    return this.getClusters().find((c) => c.id === id);
  }

  private async saveClusters(clusters: ClusterConfig[]): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(CONFIG_CLUSTERS_KEY, clusters, vscode.ConfigurationTarget.Global);
    this._onDidChangeClusters.fire();
  }

  async addCluster(
    name: string,
    brokers: string[],
    security: ClusterSecurity = {},
  ): Promise<ClusterConfig> {
    const cluster: ClusterConfig = {
      id: crypto.randomUUID(),
      name,
      brokers,
      ...(security.ssl !== undefined && security.ssl !== false ? { ssl: security.ssl } : {}),
      ...(security.sasl ? { sasl: security.sasl } : {}),
    };
    await this.storePassword(cluster, security.password);
    await this.saveClusters([...this.getClusters(), cluster]);
    return cluster;
  }

  /** Replaces TLS/SASL settings (and optionally the password), reconnecting if the cluster was connected. */
  async updateClusterSecurity(
    id: string,
    security: ClusterSecurity,
  ): Promise<ClusterConfig | undefined> {
    const clusters = this.getClusters();
    const current = clusters.find((c) => c.id === id);
    if (!current) {
      return undefined;
    }
    const updated: ClusterConfig = { id, name: current.name, brokers: current.brokers };
    if (security.ssl !== undefined && security.ssl !== false) {
      updated.ssl = security.ssl;
    }
    if (security.sasl) {
      updated.sasl = security.sasl;
    }
    await this.storePassword(updated, security.password);
    // Drop the client before saving so the config listener doesn't reconnect a second time.
    const wasConnected = await this.dropClient(id);
    await this.saveClusters(clusters.map((c) => (c.id === id ? updated : c)));
    if (wasConnected) {
      await this.connect(updated);
    }
    return updated;
  }

  private async storePassword(cluster: ClusterConfig, password: string | undefined): Promise<void> {
    if (!this.secrets) {
      return;
    }
    const key = PASSWORD_SECRET_PREFIX + cluster.id;
    if (!needsPassword(cluster.sasl)) {
      await this.secrets.delete(key);
    } else if (password !== undefined) {
      await this.secrets.store(key, password);
    }
  }

  /**
   * The stored SASL password. When there is none (hand-edited settings, or a
   * synced config on a new machine) and `interactive`, asks for it and saves it.
   */
  private async resolvePassword(
    cluster: ClusterConfig,
    interactive: boolean,
  ): Promise<string | undefined> {
    const sasl = cluster.sasl;
    if (!sasl || sasl.mechanism === "aws-iam") {
      return undefined;
    }
    const stored = await this.secrets?.get(PASSWORD_SECRET_PREFIX + cluster.id);
    if (stored !== undefined || !interactive) {
      return stored;
    }
    const password = await vscode.window.showInputBox({
      title: `Connect to "${cluster.name}"`,
      prompt: `Password for ${sasl.username} (saved in VS Code's secret storage)`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      throw new Error(`A password for "${sasl.username}" is needed to connect to "${cluster.name}".`);
    }
    await this.storePassword(cluster, password);
    return password;
  }

  async updateClusterName(
    id: string,
    name: string,
  ): Promise<ClusterConfig | undefined> {
    const clusters = this.getClusters();
    const cluster = clusters.find((c) => c.id === id);
    if (!cluster || name.length === 0) {
      return cluster;
    }
    const updated: ClusterConfig = { ...cluster, name };
    await this.saveClusters(clusters.map((c) => (c.id === id ? updated : c)));
    return updated;
  }

  async removeCluster(id: string): Promise<void> {
    await this.dropClient(id);
    this.statuses.delete(id);
    this.lastErrors.delete(id);
    this.lastHints.delete(id);
    await this.secrets?.delete(PASSWORD_SECRET_PREFIX + id);
    await this.saveClusters(this.getClusters().filter((c) => c.id !== id));
  }

  getLastError(id: string): string | undefined {
    return this.lastErrors.get(id);
  }

  /** Likely cause and fix for the last connection failure, when one can be guessed. */
  getLastHint(id: string): string | undefined {
    return this.lastHints.get(id);
  }

  private recordFailure(cluster: ClusterConfig, error: unknown, what: string): void {
    const hint = explainConnectionError(cluster, error);
    this.log(`${what} "${cluster.name}": ${describeError(error)}${hint ? `\n  Hint: ${hint}` : ""}`);
    this.lastErrors.set(cluster.id, describeError(error));
    if (hint) {
      this.lastHints.set(cluster.id, hint);
    } else {
      this.lastHints.delete(cluster.id);
    }
  }

  getStatus(id: string): ConnectionStatus {
    return this.statuses.get(id) ?? "disconnected";
  }

  private setStatus(id: string, status: ConnectionStatus): void {
    this.statuses.set(id, status);
    this._onDidChangeStatus.fire(id);
  }

  private async getKafka(cluster: ClusterConfig, interactive = false): Promise<Kafka> {
    const key = connectionKey(cluster);
    const cached = this.kafkaInstances.get(cluster.id);
    // Instances injected without a key (tests) are always reused.
    if (cached && (this.connectionKeys.get(cluster.id) ?? key) === key) {
      return cached;
    }
    const password = await this.resolvePassword(cluster, interactive);
    const kafka = new Kafka(buildKafkaConfig(cluster, password));
    this.kafkaInstances.set(cluster.id, kafka);
    this.connectionKeys.set(cluster.id, key);
    return kafka;
  }

  async connect(cluster: ClusterConfig): Promise<void> {
    if (this.getStatus(cluster.id) === "connected") {
      return;
    }
    this.setStatus(cluster.id, "connecting");
    let admin: Admin | undefined;
    try {
      admin = (await this.getKafka(cluster, true)).admin({
        retry: { retries: 2, initialRetryTime: 300, maxRetryTime: 2_000 },
      });
      await admin.connect();
      // Cheap round-trip to confirm the brokers actually respond.
      await admin.listTopics();
      this.admins.set(cluster.id, this.guardAdmin(cluster, admin));
      this.lastErrors.delete(cluster.id);
      this.lastHints.delete(cluster.id);
      this.setStatus(cluster.id, "connected");
    } catch (error) {
      await admin?.disconnect().catch(() => undefined);
      this.recordFailure(cluster, error, "Failed to connect to");
      this.setStatus(cluster.id, "error");
      throw error;
    }
  }

  async disconnect(id: string): Promise<void> {
    const admin = this.admins.get(id);
    if (admin) {
      this.admins.delete(id);
      try {
        await admin.disconnect();
      } catch {
        // Best-effort: the connection may already be dead.
      }
    }
    this.setStatus(id, "disconnected");
  }

  private ensureAdmin(cluster: ClusterConfig): Admin {
    const admin = this.admins.get(cluster.id);
    if (!admin) {
      throw new Error(`Not connected to "${cluster.name}". Connect first.`);
    }
    return admin;
  }

  async listTopics(cluster: ClusterConfig): Promise<TopicInfo[]> {
    const admin = this.ensureAdmin(cluster);
    const { topics } = await admin.fetchTopicMetadata();
    return topics
      .filter((t) => !t.name.startsWith("__"))
      .map(toTopicInfo)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async describeTopic(
    cluster: ClusterConfig,
    topic: string,
  ): Promise<TopicInfo> {
    const admin = this.ensureAdmin(cluster);
    const { topics } = await admin.fetchTopicMetadata({ topics: [topic] });
    return toTopicInfo(topics[0]);
  }

  async createTopic(
    cluster: ClusterConfig,
    topic: string,
    numPartitions: number,
    replicationFactor: number,
  ): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    const created = await admin.createTopics({
      waitForLeaders: true,
      topics: [{ topic, numPartitions, replicationFactor }],
    });
    if (!created) {
      throw new Error(`Topic "${topic}" already exists`);
    }
  }

  async deleteTopic(cluster: ClusterConfig, topic: string): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    await admin.deleteTopics({ topics: [topic] });
  }

  async listConsumerGroups(cluster: ClusterConfig): Promise<GroupOverview[]> {
    const admin = this.ensureAdmin(cluster);
    const { groups } = await admin.listGroups();
    return groups.slice().sort((a, b) => a.groupId.localeCompare(b.groupId));
  }

  async describeConsumerGroup(cluster: ClusterConfig, groupId: string) {
    const admin = this.ensureAdmin(cluster);
    const { groups } = await admin.describeGroups([groupId]);
    return groups[0];
  }

  async deleteConsumerGroup(
    cluster: ClusterConfig,
    groupId: string,
  ): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    await admin.deleteGroups([groupId]);
  }

  async getGroupDetails(
    cluster: ClusterConfig,
    groupId: string,
  ): Promise<GroupDetails> {
    const group = await this.describeConsumerGroup(cluster, groupId);
    const members = group.members.map((member) => {
      let assignment: GroupDetails["members"][number]["assignment"] = [];
      try {
        const decoded = AssignerProtocol.MemberAssignment.decode(
          member.memberAssignment,
        );
        if (decoded) {
          assignment = Object.entries(decoded.assignment).map(
            ([topic, partitions]) => ({
              topic,
              partitions,
            }),
          );
        }
      } catch {
        // Non-"consumer" protocol types (or an empty assignment) can't be decoded; leave empty.
      }
      return {
        memberId: member.memberId,
        clientId: member.clientId,
        clientHost: member.clientHost,
        assignment,
      };
    });
    return {
      groupId: group.groupId,
      state: group.state,
      protocol: group.protocol,
      protocolType: group.protocolType,
      members,
    };
  }

  /** Resets every partition of `topic` for `groupId` to its earliest/latest offset. Fails if the group has active members. */
  async resetGroupOffsets(
    cluster: ClusterConfig,
    groupId: string,
    topic: string,
    position: "earliest" | "latest",
  ): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    await admin.resetOffsets({
      groupId,
      topic,
      earliest: position === "earliest",
    });
  }

  /** Moves a single partition's committed offset to its earliest/latest watermark. Fails if the group has active members. */
  async setGroupOffsetToEdge(
    cluster: ClusterConfig,
    groupId: string,
    topic: string,
    partition: number,
    edge: "earliest" | "latest",
  ): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    const watermarks = await admin.fetchTopicOffsets(topic);
    const watermark = watermarks.find((w) => w.partition === partition);
    if (!watermark) {
      throw new Error(`Partition ${partition} not found for topic "${topic}".`);
    }
    const offset = edge === "earliest" ? watermark.low : watermark.high;
    await admin.setOffsets({
      groupId,
      topic,
      partitions: [{ partition, offset }],
    });
  }

  /** Sets a single partition's committed offset to an exact value. Fails if the group has active members. */
  async setGroupOffset(
    cluster: ClusterConfig,
    groupId: string,
    topic: string,
    partition: number,
    offset: string,
  ): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    await admin.setOffsets({
      groupId,
      topic,
      partitions: [{ partition, offset }],
    });
  }

  /**
   * Registers a new consumer group by briefly running a real consumer against `topic`.
   * Kafka only persists a group once it has committed at least one offset, so if the
   * topic has no messages to consume within the window, the group won't stick around.
   */
  async createConsumerGroup(
    cluster: ClusterConfig,
    groupId: string,
    topic: string,
    fromBeginning: boolean,
  ): Promise<void> {
    const consumer = (await this.getKafka(cluster)).consumer({ groupId });
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning });
      const running = consumer.run({
        eachMessage: async () => undefined,
      });
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } finally {
      await consumer.disconnect().catch(() => undefined);
    }
  }

  async fetchGroupOffsets(
    cluster: ClusterConfig,
    groupId: string,
  ): Promise<GroupOffsetEntry[]> {
    const admin = this.ensureAdmin(cluster);
    const topicOffsets = await admin.fetchOffsets({ groupId });
    const entries: GroupOffsetEntry[] = [];
    for (const { topic, partitions } of topicOffsets) {
      const highWatermarks = await admin.fetchTopicOffsets(topic);
      for (const p of partitions) {
        const hw = highWatermarks.find((h) => h.partition === p.partition);
        const high = hw?.high ?? "0";
        const lag =
          p.offset === "-1" ? high : String(BigInt(high) - BigInt(p.offset));
        entries.push({
          topic,
          partition: p.partition,
          offset: p.offset,
          low: hw?.low ?? "0",
          high,
          lag,
        });
      }
    }
    return entries.sort(
      (a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition,
    );
  }

  /**
   * Collects everything the cluster dashboard shows in one pass: broker
   * layout, partition health, topic sizes and per-group lag. Watermarks are
   * fetched once per topic and shared by every group's lag calculation.
   */
  async getClusterOverview(cluster: ClusterConfig): Promise<ClusterOverview> {
    const admin = this.ensureAdmin(cluster);
    const [description, topics, groupList] = await Promise.all([
      admin.describeCluster(),
      this.listTopics(cluster),
      admin.listGroups(),
    ]);

    const groupIds = groupList.groups.map((g) => g.groupId);
    const [watermarkEntries, described, groupOffsets] = await Promise.all([
      Promise.all(
        topics.map(async (t) => {
          try {
            return [t.name, await admin.fetchTopicOffsets(t.name)] as const;
          } catch (error) {
            this.log(
              `Dashboard: failed to fetch offsets for "${t.name}": ${describeError(error)}`,
            );
            return [t.name, [] as RawWatermark[]] as const;
          }
        }),
      ),
      groupIds.length > 0
        ? admin.describeGroups(groupIds)
        : Promise.resolve({ groups: [] }),
      Promise.all(
        groupIds.map((groupId) =>
          admin.fetchOffsets({ groupId }).catch((error) => {
            this.log(
              `Dashboard: failed to fetch offsets for group "${groupId}": ${describeError(error)}`,
            );
            return [];
          }),
        ),
      ),
    ]);

    const watermarks = new Map<string, RawWatermark[]>(watermarkEntries);
    const groups: RawGroup[] = groupIds.map((groupId, i) => {
      const info = described.groups.find((g) => g.groupId === groupId);
      return {
        groupId,
        state: info?.state ?? "Unknown",
        memberCount: info?.members.length ?? 0,
        offsets: groupOffsets[i],
      };
    });

    return buildClusterOverview({
      clusterId: description.clusterId,
      controllerId: description.controller,
      brokers: description.brokers,
      topics,
      watermarks,
      groups,
    });
  }

  async getTopicDetails(
    cluster: ClusterConfig,
    topic: string,
  ): Promise<TopicDetails> {
    const admin = this.ensureAdmin(cluster);
    const [info, watermarks] = await Promise.all([
      this.describeTopic(cluster, topic),
      admin.fetchTopicOffsets(topic),
    ]);
    let total = 0n;
    const partitions = info.partitions.map((p) => {
      const w = watermarks.find((x) => x.partition === p.partitionId);
      const low = w?.low ?? "0";
      const high = w?.high ?? "0";
      const count = BigInt(high) - BigInt(low);
      total += count > 0n ? count : 0n;
      return {
        ...p,
        low,
        high,
        messageCount: (count > 0n ? count : 0n).toString(),
      };
    });
    return {
      name: info.name,
      partitions,
      replicationFactor: Math.max(
        0,
        ...partitions.map((p) => p.replicas.length),
      ),
      underReplicated: partitions.filter(
        (p) => p.isr.length < p.replicas.length,
      ).length,
      offline: partitions.filter((p) => p.leader < 0).length,
      messageCount: total.toString(),
    };
  }

  async getTopicConfig(
    cluster: ClusterConfig,
    topic: string,
  ): Promise<TopicConfigEntry[]> {
    const admin = this.ensureAdmin(cluster);
    const { resources } = await admin.describeConfigs({
      includeSynonyms: false,
      resources: [{ type: ConfigResourceTypes.TOPIC, name: topic }],
    });
    return (resources[0]?.configEntries ?? [])
      .map((e) => ({
        name: e.configName,
        value: e.isSensitive ? "********" : e.configValue,
        isDefault: e.isDefault,
        readOnly: e.readOnly,
        isSensitive: e.isSensitive,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async resetGroupOffsetsTo(
    cluster: ClusterConfig,
    groupId: string,
    topic: string,
    spec: ResetSpec,
  ): Promise<OffsetMove[]> {
    const admin = this.ensureAdmin(cluster);
    const entries = (await this.fetchGroupOffsets(cluster, groupId)).filter(
      (e) => e.topic === topic,
    );
    let moves: OffsetMove[];
    if (spec.mode === "timestamp") {
      const [byTime, watermarks] = await Promise.all([
        admin.fetchTopicOffsetsByTimestamp(topic, spec.timestamp),
        admin.fetchTopicOffsets(topic),
      ]);
      moves = byTime.map((t) => {
        const high =
          watermarks.find((w) => w.partition === t.partition)?.high ?? "0";
        const from =
          entries.find((e) => e.partition === t.partition)?.offset ?? "-1";
        return {
          partition: t.partition,
          from,
          to: t.offset === "-1" ? high : t.offset,
        };
      });
    } else {
      moves = planReset(entries, topic, spec).moves;
    }
    if (moves.length === 0) {
      throw new Error(`"${groupId}" has no partitions of "${topic}" to reset.`);
    }
    await admin.setOffsets({
      groupId,
      topic,
      partitions: moves.map((m) => ({ partition: m.partition, offset: m.to })),
    });
    return moves;
  }

  private getProducer(cluster: ClusterConfig): Promise<Producer> {
    let p = this.producers.get(cluster.id);
    if (!p) {
      p = this.getKafka(cluster).then(async (kafka) => {
        const producer = kafka.producer();
        await producer.connect();
        return producer;
      });
      p.catch(() => this.producers.delete(cluster.id));
      this.producers.set(cluster.id, p);
    }
    return p;
  }

  async produce(
    cluster: ClusterConfig,
    topic: string,
    options: ProduceOptions,
  ): Promise<void> {
    const producer = await this.getProducer(cluster);
    try {
      await producer.send({
        topic,
        messages: [
          {
            key:
              options.key && options.key.length > 0 ? options.key : undefined,
            value: options.value,
            partition: options.partition,
            headers:
              options.headers && Object.keys(options.headers).length > 0
                ? options.headers
                : undefined,
          },
        ],
      });
    } finally {
      await producer.disconnect();
    }
  }

  /**
   * Starts a live tail from the latest offset. Returns a handle whose
   * `stop()` disconnects the underlying consumer.
   */
  async startTail(
    cluster: ClusterConfig,
    topic: string,
    onMessage: (message: ConsumedMessage) => void,
    onError: (error: unknown) => void,
  ): Promise<{ stop: () => Promise<void> }> {
    const consumer = (await this.getKafka(cluster)).consumer({
      groupId: `vscode-kafka-tail-${crypto.randomUUID()}`,
    });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: false });
    consumer
      .run({
        eachMessage: async ({ partition, message }) => {
          onMessage({
            partition,
            offset: message.offset,
            key: message.key?.toString() ?? null,
            value: message.value?.toString() ?? null,
            timestamp: message.timestamp,
            headers: decodeHeaders(message.headers),
          });
        },
      })
      .catch(onError);

    return {
      stop: async () => {
        try {
          await consumer.disconnect();
        } catch {
          // Ignore: panel is closing anyway.
        }
      },
    };
  }

  /**
   * Fetches up to `limitPerPartition` of the most recent messages per
   * partition, then disconnects. Uses a throwaway consumer group so it never
   * disturbs real consumer group offsets.
   */
  async loadRecentMessages(
    cluster: ClusterConfig,
    topic: string,
    limitPerPartition: number,
  ): Promise<ConsumedMessage[]> {
    const admin = this.ensureAdmin(cluster);
    const watermarks = await admin.fetchTopicOffsets(topic);
    const targets = new Map<number, bigint>();
    const startOffsets = new Map<number, string>();

    for (const w of watermarks) {
      const low = BigInt(w.low);
      const high = BigInt(w.high);
      if (high === low) {
        continue; // empty partition
      }
      targets.set(w.partition, high);
      const start = high - BigInt(limitPerPartition);
      startOffsets.set(w.partition, (start > low ? start : low).toString());
    }

    if (targets.size === 0) {
      return [];
    }

    const consumer = (await this.getKafka(cluster)).consumer({
      groupId: `vscode-kafka-history-${crypto.randomUUID()}`,
    });
    const collected: ConsumedMessage[] = [];

    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });

      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const timeout = setTimeout(finish, 15000);

        consumer
          .run({
            eachMessage: async ({ partition, message }) => {
              collected.push({
                partition,
                offset: message.offset,
                key: message.key?.toString() ?? null,
                value: message.value?.toString() ?? null,
                timestamp: message.timestamp,
                headers: decodeHeaders(message.headers),
              });
              const target = targets.get(partition);
              if (
                target !== undefined &&
                BigInt(message.offset) + 1n >= target
              ) {
                targets.delete(partition);
                if (targets.size === 0) {
                  clearTimeout(timeout);
                  finish();
                }
              }
            },
          })
          .catch(() => finish());

        for (const [partition, offset] of startOffsets) {
          consumer.seek({ topic, partition, offset });
        }
      });
    } finally {
      // handle leak consumer
      await consumer.disconnect().catch(() => undefined);
    }

    collected.sort(
      (a, b) =>
        a.partition - b.partition ||
        Number(BigInt(a.offset) - BigInt(b.offset)),
    );
    return collected;
  }

  log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  showOutput(): void {
    this.output.show();
  }

  dispose(): void {
    for (const admin of this.admins.values()) {
      admin.disconnect().catch(() => undefined);
    }
    this.configListener.dispose();
    this.output.dispose();
    this._onDidChangeStatus.dispose();
    this._onDidChangeClusters.dispose();
    this._onDidLoseConnection.dispose();
  }

  // Wraps `admin` so any call rejecting with a connections-class error drops
  private guardAdmin(cluster: ClusterConfig, admin: Admin): Admin {
    const guarded: Admin = new Proxy(admin, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          if (result instanceof Promise) {
            return result.catch((error: unknown) => {
              if (isConnectionError(error)) {
                this.handleLost(cluster, guarded, error);
              }
              throw error;
            });
          }
          return result;
        };
      },
    });
    return guarded;
  }
  private handleLost(cluster: ClusterConfig, admin: Admin, error: unknown) {
    if (this.admins.get(cluster.id) !== admin) {
      return;
    }
    this.admins.delete(cluster.id);
    this.recordFailure(cluster, error, "Lost connection to");
    admin.disconnect().catch(() => undefined);
    this.setStatus(cluster.id, "error");
    // notify on subscribers
    this._onDidLoseConnection.fire(cluster);
  }

  async reconnect(cluster: ClusterConfig): Promise<void> {
    await this.disconnect(cluster.id);
    await this.connect(cluster);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Node reports dual-stack ECONNREFUSED as an AggregateError with an empty
    // message, which leaves KafkaJS saying just "Connection error: ".
    if (/:\s*$/.test(error.message)) {
      const code = errorCode(error);
      if (code) {
        return `${error.message.trimEnd()} ${code}`;
      }
    }
    return error.message;
  }
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  for (let e = error, depth = 0; e instanceof Error && depth < 5; depth++) {
    const { code, cause } = e as Error & { code?: unknown; cause?: unknown };
    if (typeof code === "string") {
      return code;
    }
    e = cause;
  }
  return undefined;
}

export function isConnectionError(error: unknown): boolean {
  if (error instanceof KafkaJSNumberOfRetriesExceeded) {
    return isConnectionError(error.cause);
  }
  return (
    error instanceof KafkaJSConnectionError ||
    error instanceof KafkaJSRequestTimeoutError ||
    error instanceof KafkaJSBrokerNotFound
  );
}
