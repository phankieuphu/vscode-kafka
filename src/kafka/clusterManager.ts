import * as crypto from "crypto";
import * as vscode from "vscode";
import {
  Admin,
  AssignerProtocol,
  Kafka,
  GroupOverview,
  ITopicMetadata,
} from "kafkajs";
import {
  ClusterConfig,
  ConnectionStatus,
  ConsumedMessage,
  GroupDetails,
  GroupOffsetEntry,
  PartitionInfo,
  TopicInfo,
} from "./types";

const CONFIG_SECTION = "kafka";
const CONFIG_CLUSTERS_KEY = "clusters";

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

/**
 * Owns cluster configuration (persisted in the `kafka.clusters` setting),
 * live connection state, and every KafkaJS admin/producer/consumer operation
 * used by the tree view and topic panels.
 */
export class ClusterManager implements vscode.Disposable {
  private readonly statuses = new Map<string, ConnectionStatus>();
  private readonly kafkaInstances = new Map<string, Kafka>();
  private readonly admins = new Map<string, Admin>();
  private readonly output = vscode.window.createOutputChannel("Kafka Manager");

  private readonly _onDidChangeStatus = new vscode.EventEmitter<string>();
  readonly onDidChangeStatus = this._onDidChangeStatus.event;

  private readonly _onDidChangeClusters = new vscode.EventEmitter<void>();
  readonly onDidChangeClusters = this._onDidChangeClusters.event;

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

  async addCluster(name: string, brokers: string[]): Promise<ClusterConfig> {
    const cluster: ClusterConfig = { id: crypto.randomUUID(), name, brokers };
    await this.saveClusters([...this.getClusters(), cluster]);
    return cluster;
  }

  async updateClusterName(
    id: string,
    name: string,
  ): Promise<ClusterConfig | undefined> {
    const cluster: ClusterConfig | undefined = this.getCluster(id);
    if (!cluster) {
      return cluster;
    }
    if (name.length > 0) {
      cluster.name = name;
    }
    return cluster;
  }

  async removeCluster(id: string): Promise<void> {
    await this.disconnect(id);
    this.kafkaInstances.delete(id);
    this.statuses.delete(id);
    await this.saveClusters(this.getClusters().filter((c) => c.id !== id));
  }

  getStatus(id: string): ConnectionStatus {
    return this.statuses.get(id) ?? "disconnected";
  }

  private setStatus(id: string, status: ConnectionStatus): void {
    this.statuses.set(id, status);
    this._onDidChangeStatus.fire(id);
  }

  private getKafka(cluster: ClusterConfig): Kafka {
    let kafka = this.kafkaInstances.get(cluster.id);
    if (!kafka) {
      kafka = new Kafka({ clientId: "vscode-kafka", brokers: cluster.brokers });
      this.kafkaInstances.set(cluster.id, kafka);
    }
    return kafka;
  }

  async connect(cluster: ClusterConfig): Promise<void> {
    if (this.getStatus(cluster.id) === "connected") {
      return;
    }
    this.setStatus(cluster.id, "connecting");
    try {
      const admin = this.getKafka(cluster).admin();
      await admin.connect();
      // Cheap round-trip to confirm the brokers actually respond.
      await admin.listTopics();
      this.admins.set(cluster.id, admin);
      this.setStatus(cluster.id, "connected");
    } catch (error) {
      this.log(
        `Failed to connect to "${cluster.name}": ${describeError(error)}`,
      );
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
    await admin.createTopics({
      waitForLeaders: true,
      topics: [{ topic, numPartitions, replicationFactor }],
    });
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
    const consumer = this.getKafka(cluster).consumer({ groupId });
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning });
      const running = consumer.run({ eachMessage: async () => undefined });
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
          high,
          lag,
        });
      }
    }
    return entries.sort(
      (a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition,
    );
  }

  async produce(
    cluster: ClusterConfig,
    topic: string,
    key: string | undefined,
    value: string,
  ): Promise<void> {
    const producer = this.getKafka(cluster).producer();
    await producer.connect();
    try {
      await producer.send({
        topic,
        messages: [{ key: key && key.length > 0 ? key : undefined, value }],
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
    const consumer = this.getKafka(cluster).consumer({
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

    const consumer = this.getKafka(cluster).consumer({
      groupId: `vscode-kafka-history-${crypto.randomUUID()}`,
    });
    const collected: ConsumedMessage[] = [];

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
            });
            const target = targets.get(partition);
            if (target !== undefined && BigInt(message.offset) + 1n >= target) {
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

    await consumer.disconnect();
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
    this.output.dispose();
    this._onDidChangeStatus.dispose();
    this._onDidChangeClusters.dispose();
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
