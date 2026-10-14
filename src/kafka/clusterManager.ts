import * as crypto from "crypto";
import * as vscode from "vscode";
import {
  Admin,
  AclOperationTypes,
  AclPermissionTypes,
  AclResourceTypes,
  AssignerProtocol,
  ConfigResourceTypes,
  ConfigSource,
  Consumer,
  IHeaders,
  Kafka,
  KafkaMessage,
  GroupOverview,
  ITopicMetadata,
  Producer,
  ResourcePatternTypes,
  KafkaJSNumberOfRetriesExceeded,
  KafkaJSConnectionError,
  KafkaJSRequestTimeoutError,
  KafkaJSBrokerNotFound,
} from "kafkajs";
import { matchesSearch, planRanges, widenForSearch } from "./browse";
import {
  buildKafkaConfig,
  connectionKey,
  needsPassword,
} from "./connectionConfig";
import { explainConnectionError } from "./connectionHints";
import { buildClusterOverview, RawGroup, RawWatermark } from "./dashboard";
import { decodeField } from "./decode";
import { partitionLag } from "./lag";
import { planReset } from "./offsets";
import { SchemaRegistryClient } from "./schemaRegistry";
import { ConfigChanges, mergeTopicOverrides } from "./topicConfig";
import {
  AclEntry,
  BrokerDetails,
  BrokerSummary,
  BrowseRequest,
  BrowseResult,
  ClusterConfig,
  ClusterOverview,
  ClusterSchemaRegistry,
  ClusterSecurity,
  ClusterSource,
  ConnectionStatus,
  ConsumedMessage,
  GroupDetails,
  GroupOffsetEntry,
  MessageFormat,
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
const REGISTRY_SECRET_PREFIX = "kafka-manager.registryPassword.";

/**
 * Prefix of the short-lived groups the message browser and live tail use.
 * They never commit offsets, are deleted afterwards, and are hidden from the
 * tree and dashboard (including any left behind by versions before 0.3.0).
 */
export const INTERNAL_GROUP_PREFIX = "vscode-kafka-";

export function isInternalGroup(groupId: string): boolean {
  return groupId.startsWith(INTERNAL_GROUP_PREFIX);
}

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

const CONFIG_SOURCES: Record<number, string> = {
  [ConfigSource.TOPIC_CONFIG]: "topic",
  [ConfigSource.DYNAMIC_BROKER_CONFIG]: "dynamic (this broker)",
  [ConfigSource.DYNAMIC_DEFAULT_BROKER_CONFIG]: "dynamic (all brokers)",
  [ConfigSource.STATIC_BROKER_CONFIG]: "server.properties",
  [ConfigSource.DEFAULT_CONFIG]: "default",
  [ConfigSource.DYNAMIC_BROKER_LOGGER_CONFIG]: "logger",
};

function enumName(values: Record<string, string | number>, value: number): string {
  const name = Object.entries(values).find(([, v]) => v === value)?.[0];
  return name ?? String(value);
}

type Format = { key: MessageFormat; value: MessageFormat };
const DEFAULT_FORMAT: Format = { key: "auto", value: "auto" };

/**
 * Owns cluster configuration (persisted in the `kafka.clusters` setting, in
 * user or workspace settings), live connection state, and every KafkaJS
 * admin/producer/consumer operation used by the tree view and panels.
 */
export class ClusterManager implements vscode.Disposable {
  private readonly statuses = new Map<string, ConnectionStatus>();
  private readonly kafkaInstances = new Map<string, Kafka>();
  /** connectionKey() of the config each cached Kafka instance was built from. */
  private readonly connectionKeys = new Map<string, string>();
  private readonly admins = new Map<string, Admin>();
  private readonly lastErrors = new Map<string, string>();
  private readonly lastHints = new Map<string, string>();
  private readonly registries = new Map<string, { key: string; client: SchemaRegistryClient }>();
  /** Stop functions of the tails and browses running per cluster, so a disconnect can end them. */
  private readonly consumers = new Map<string, Set<() => Promise<void>>>();
  private readonly configListeners: vscode.Disposable[];
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
    this.configListeners = [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_CLUSTERS_KEY}`)) {
          void this.applyConfigChanges();
        }
      }),
      // Workspace clusters are ignored until the workspace is trusted.
      vscode.workspace.onDidGrantWorkspaceTrust(() => this._onDidChangeClusters.fire()),
    ];
  }

  /**
   * Reacts to any change of `kafka.clusters`, including hand edits:
   * rebuilds clients whose brokers/security changed (reconnecting if they were
   * connected), forgets clusters that were removed, and refreshes listeners.
   */
  private async applyConfigChanges(): Promise<void> {
    const clusters = new Map(this.getClusters().map((c) => [c.id, c]));
    for (const [id, key] of [...this.connectionKeys]) {
      const cluster = clusters.get(id);
      if (cluster && connectionKey(cluster) === key) {
        continue;
      }
      const wasConnected = await this.dropClient(id);
      if (cluster && wasConnected) {
        this.log(`Connection settings for "${cluster.name}" changed; reconnecting.`);
        this.connect(cluster).catch(() => undefined);
      }
    }
    for (const id of new Set([...this.statuses.keys(), ...this.admins.keys(), ...this.registries.keys()])) {
      if (!clusters.has(id)) {
        await this.forget(id);
      }
    }
    for (const [id, cached] of [...this.registries]) {
      if (registryKey(clusters.get(id)?.schemaRegistry) !== cached.key) {
        this.registries.delete(id);
      }
    }
    this._onDidChangeClusters.fire();
  }

  /** Drops every trace of a cluster that no longer exists in settings. */
  private async forget(id: string): Promise<void> {
    await this.dropClient(id);
    this.statuses.delete(id);
    this.lastErrors.delete(id);
    this.lastHints.delete(id);
    this.registries.delete(id);
  }

  /** Forgets the cached client (and its producer/admin/consumers) so the next use rebuilds it from the current config. */
  private async dropClient(id: string): Promise<boolean> {
    const wasConnected = this.getStatus(id) === "connected";
    this.kafkaInstances.delete(id);
    this.connectionKeys.delete(id);
    this.dropProducer(id);
    if (this.admins.has(id) || this.getStatus(id) !== "disconnected") {
      await this.disconnect(id);
    } else {
      await this.stopConsumers(id);
    }
    return wasConnected;
  }

  private dropProducer(id: string): void {
    const producer = this.producers.get(id);
    if (producer) {
      this.producers.delete(id);
      producer.then((p) => p.disconnect()).catch(() => undefined);
    }
  }

  // ---- Configuration --------------------------------------------------------

  private readClusters(): Array<{ cluster: ClusterConfig; source: ClusterSource }> {
    const inspected = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .inspect<ClusterConfig[]>(CONFIG_CLUSTERS_KEY);
    const result: Array<{ cluster: ClusterConfig; source: ClusterSource }> = [];
    const seen = new Set<string>();
    const add = (list: ClusterConfig[] | undefined, source: ClusterSource) => {
      for (const cluster of Array.isArray(list) ? list : []) {
        if (cluster && typeof cluster.id === "string" && Array.isArray(cluster.brokers) && !seen.has(cluster.id)) {
          seen.add(cluster.id);
          result.push({ cluster, source });
        }
      }
    };
    add(inspected?.globalValue, "user");
    // Workspace settings can come from a cloned repo: only honour them once trusted.
    if (vscode.workspace.isTrusted) {
      add(inspected?.workspaceValue, "workspace");
    }
    return result;
  }

  getClusters(): ClusterConfig[] {
    return this.readClusters().map((c) => c.cluster);
  }

  getCluster(id: string): ClusterConfig | undefined {
    return this.getClusters().find((c) => c.id === id);
  }

  /** Which settings file holds the cluster: user settings, or the workspace's `.vscode/settings.json`. */
  getClusterSource(id: string): ClusterSource | undefined {
    return this.readClusters().find((c) => c.cluster.id === id)?.source;
  }

  /** Rewrites the cluster list stored in one settings scope. */
  private async writeClusters(
    source: ClusterSource,
    update: (clusters: ClusterConfig[]) => ClusterConfig[],
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const inspected = configuration.inspect<ClusterConfig[]>(CONFIG_CLUSTERS_KEY);
    const current = (source === "workspace" ? inspected?.workspaceValue : inspected?.globalValue) ?? [];
    await configuration.update(
      CONFIG_CLUSTERS_KEY,
      update(current),
      source === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
    );
    this._onDidChangeClusters.fire();
  }

  /** Replaces one cluster's entry wherever it is stored. */
  private async replaceCluster(updated: ClusterConfig): Promise<void> {
    const source = this.getClusterSource(updated.id) ?? "user";
    await this.writeClusters(source, (clusters) => clusters.map((c) => (c.id === updated.id ? updated : c)));
  }

  async addCluster(
    name: string,
    brokers: string[],
    security: ClusterSecurity = {},
    source: ClusterSource = "user",
  ): Promise<ClusterConfig> {
    if (source === "workspace" && !vscode.workspace.workspaceFolders?.length) {
      throw new Error("Open a folder or workspace to save a cluster to workspace settings.");
    }
    const cluster: ClusterConfig = {
      id: crypto.randomUUID(),
      name,
      brokers,
      ...(security.ssl !== undefined && security.ssl !== false ? { ssl: security.ssl } : {}),
      ...(security.sasl ? { sasl: security.sasl } : {}),
    };
    await this.storePassword(cluster, security.password);
    await this.writeClusters(source, (clusters) => [...clusters, cluster]);
    return cluster;
  }

  /** Replaces TLS/SASL settings (and optionally the password), reconnecting if the cluster was connected. */
  async updateClusterSecurity(
    id: string,
    security: ClusterSecurity,
  ): Promise<ClusterConfig | undefined> {
    const current = this.getCluster(id);
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
    if (current.schemaRegistry) {
      updated.schemaRegistry = current.schemaRegistry;
    }
    await this.storePassword(updated, security.password);
    // Drop the client before saving so the config listener doesn't reconnect a second time.
    const wasConnected = await this.dropClient(id);
    await this.replaceCluster(updated);
    if (wasConnected) {
      await this.connect(updated);
    }
    return updated;
  }

  /** Sets or clears (`undefined`) the cluster's Schema Registry. `password` undefined keeps the saved one. */
  async updateSchemaRegistry(
    id: string,
    registry: ClusterSchemaRegistry | undefined,
    password?: string,
  ): Promise<ClusterConfig | undefined> {
    const current = this.getCluster(id);
    if (!current) {
      return undefined;
    }
    const updated: ClusterConfig = { ...current };
    if (registry) {
      updated.schemaRegistry = registry;
    } else {
      delete updated.schemaRegistry;
    }
    if (this.secrets) {
      if (!registry?.username) {
        await this.secrets.delete(REGISTRY_SECRET_PREFIX + id);
      } else if (password !== undefined) {
        await this.secrets.store(REGISTRY_SECRET_PREFIX + id, password);
      }
    }
    this.registries.delete(id);
    await this.replaceCluster(updated);
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
   * The stored SASL password. When there is none (hand-edited settings, a
   * synced config on a new machine, or a cluster shared through workspace
   * settings) and `interactive`, asks for it and saves it.
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

  /** Saved SASL and Schema Registry passwords, without prompting; for redaction. */
  async getStoredSecrets(id: string): Promise<string[]> {
    const values = await Promise.all([
      this.secrets?.get(PASSWORD_SECRET_PREFIX + id),
      this.secrets?.get(REGISTRY_SECRET_PREFIX + id),
    ]);
    return values.filter((v): v is string => !!v);
  }

  async updateClusterName(
    id: string,
    name: string,
  ): Promise<ClusterConfig | undefined> {
    const cluster = this.getCluster(id);
    if (!cluster || name.length === 0) {
      return cluster;
    }
    const updated: ClusterConfig = { ...cluster, name };
    await this.replaceCluster(updated);
    return updated;
  }

  async removeCluster(id: string): Promise<void> {
    const source = this.getClusterSource(id) ?? "user";
    await this.forget(id);
    await this.secrets?.delete(PASSWORD_SECRET_PREFIX + id);
    await this.secrets?.delete(REGISTRY_SECRET_PREFIX + id);
    await this.writeClusters(source, (clusters) => clusters.filter((c) => c.id !== id));
  }

  // ---- Connection -----------------------------------------------------------

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

  /** Closes the admin client and stops every tail/browse running against the cluster. */
  async disconnect(id: string): Promise<void> {
    await this.stopConsumers(id);
    this.dropProducer(id);
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

  // ---- Topics ---------------------------------------------------------------

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
    let topics: ITopicMetadata[];
    try {
      ({ topics } = await admin.fetchTopicMetadata({ topics: [topic] }));
    } catch (error) {
      if ((error as { type?: string }).type === "UNKNOWN_TOPIC_OR_PARTITION") {
        throw new Error(`Topic "${topic}" no longer exists on "${cluster.name}".`);
      }
      throw error;
    }
    const metadata = topics.find((t) => t.name === topic);
    if (!metadata) {
      throw new Error(`Topic "${topic}" no longer exists on "${cluster.name}".`);
    }
    return toTopicInfo(metadata);
  }

  async createTopic(
    cluster: ClusterConfig,
    topic: string,
    numPartitions: number,
    replicationFactor: number,
    config: Record<string, string> = {},
  ): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    const configEntries = Object.entries(config).map(([name, value]) => ({ name, value }));
    const created = await admin.createTopics({
      waitForLeaders: false,
      topics: [{ topic, numPartitions, replicationFactor, ...(configEntries.length ? { configEntries } : {}) }],
    });
    if (!created) {
      throw new Error(`Topic "${topic}" already exists`);
    }
    await this.waitForLeaders(admin, topic, numPartitions);
  }

  /**
   * Waits (up to `timeoutMs`) until every partition of a new topic has a leader.
   * KafkaJS's own `waitForLeaders` only retries LEADER_NOT_AVAILABLE, but a
   * broker can briefly answer UNKNOWN_TOPIC_OR_PARTITION for a topic it has just
   * created, which made Create Topic fail although the topic existed.
   */
  private async waitForLeaders(admin: Admin, topic: string, partitions: number, timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const { topics } = await admin.fetchTopicMetadata({ topics: [topic] });
        const metadata = topics.find((t) => t.name === topic);
        if (metadata && metadata.partitions.length >= partitions && metadata.partitions.every((p) => p.leader >= 0)) {
          return;
        }
      } catch (error) {
        const type = (error as { type?: string }).type;
        if (type !== "UNKNOWN_TOPIC_OR_PARTITION" && type !== "LEADER_NOT_AVAILABLE") {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The topic exists; leaders are just slow to be elected. Not worth failing over.
    this.log(`Created "${topic}", but not every partition had a leader after ${timeoutMs / 1000}s.`);
  }

  async deleteTopic(cluster: ClusterConfig, topic: string): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    await admin.deleteTopics({ topics: [topic] });
  }

  /** Raises the partition count to `count`. Kafka can't remove partitions. */
  async addPartitions(cluster: ClusterConfig, topic: string, count: number): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    await admin.createPartitions({ topicPartitions: [{ topic, count }] });
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
        isTopicOverride: (e as { configSource?: number }).configSource === ConfigSource.TOPIC_CONFIG,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Changes topic settings (`null` resets one to its default). Sends the full
   * override set, since AlterConfigs replaces it; see mergeTopicOverrides.
   */
  async alterTopicConfig(cluster: ClusterConfig, topic: string, changes: ConfigChanges): Promise<void> {
    const admin = this.ensureAdmin(cluster);
    const current = await this.getTopicConfig(cluster, topic);
    const configEntries = mergeTopicOverrides(current, changes);
    await admin.alterConfigs({
      validateOnly: false,
      resources: [{ type: ConfigResourceTypes.TOPIC, name: topic, configEntries }],
    });
  }

  async getTopicDetails(
    cluster: ClusterConfig,
    topic: string,
  ): Promise<TopicDetails> {
    const admin = this.ensureAdmin(cluster);
    const info = await this.describeTopic(cluster, topic);
    const watermarks = await admin.fetchTopicOffsets(topic);
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

  // ---- Brokers and ACLs -------------------------------------------------------

  /** Brokers with their role and how many partitions each leads and hosts. */
  async listBrokers(cluster: ClusterConfig): Promise<Array<BrokerSummary & { rack?: string }>> {
    const admin = this.ensureAdmin(cluster);
    const [description, topics] = await Promise.all([admin.describeCluster(), this.listTopics(cluster)]);
    const { brokers } = buildClusterOverview({
      clusterId: description.clusterId,
      controllerId: description.controller,
      brokers: description.brokers,
      topics,
      watermarks: new Map(),
      groups: [],
    });
    return brokers.map((b) => {
      const rack = (description.brokers.find((d) => d.nodeId === b.nodeId) as { rack?: string } | undefined)?.rack;
      return rack ? { ...b, rack } : b;
    });
  }

  async getBrokerDetails(cluster: ClusterConfig, nodeId: number): Promise<BrokerDetails> {
    const admin = this.ensureAdmin(cluster);
    const [brokers, configs] = await Promise.all([
      this.listBrokers(cluster),
      admin.describeConfigs({
        includeSynonyms: false,
        resources: [{ type: ConfigResourceTypes.BROKER, name: String(nodeId) }],
      }),
    ]);
    const broker = brokers.find((b) => b.nodeId === nodeId);
    if (!broker) {
      throw new Error(`Broker ${nodeId} isn't part of "${cluster.name}" any more.`);
    }
    return {
      ...broker,
      config: (configs.resources[0]?.configEntries ?? [])
        .map((e) => ({
          name: e.configName,
          value: e.isSensitive ? null : e.configValue,
          isDefault: e.isDefault,
          readOnly: e.readOnly,
          isSensitive: e.isSensitive,
          source: CONFIG_SOURCES[(e as { configSource?: number }).configSource ?? -1] ?? "unknown",
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Every ACL on the cluster. Fails with a clear message when no authorizer is configured. */
  async listAcls(cluster: ClusterConfig): Promise<AclEntry[]> {
    const admin = this.ensureAdmin(cluster);
    let resources;
    try {
      ({ resources } = await admin.describeAcls({
        resourceType: AclResourceTypes.ANY,
        resourcePatternType: ResourcePatternTypes.ANY,
        operation: AclOperationTypes.ANY,
        permissionType: AclPermissionTypes.ANY,
      }));
    } catch (error) {
      if ((error as { type?: string }).type === "SECURITY_DISABLED") {
        throw new Error("ACLs aren't enabled on this cluster (no authorizer is configured).");
      }
      throw error;
    }
    return resources
      .flatMap((r) =>
        r.acls.map((acl) => ({
          resourceType: enumName(AclResourceTypes as never, r.resourceType),
          resourceName: r.resourceName,
          patternType: enumName(ResourcePatternTypes as never, r.resourcePatternType),
          principal: acl.principal,
          host: acl.host,
          operation: enumName(AclOperationTypes as never, acl.operation),
          permission: enumName(AclPermissionTypes as never, acl.permissionType),
        })),
      )
      .sort((a, b) => a.principal.localeCompare(b.principal) || a.resourceName.localeCompare(b.resourceName));
  }

  // ---- Consumer groups --------------------------------------------------------

  async listConsumerGroups(cluster: ClusterConfig): Promise<GroupOverview[]> {
    const admin = this.ensureAdmin(cluster);
    const { groups } = await admin.listGroups();
    return groups
      .filter((g) => !isInternalGroup(g.groupId))
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
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
        const low = hw?.low ?? "0";
        const high = hw?.high ?? "0";
        entries.push({
          topic,
          partition: p.partition,
          offset: p.offset,
          low,
          high,
          lag: partitionLag(p.offset, low, high).toString(),
        });
      }
    }
    return entries.sort(
      (a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition,
    );
  }

  /** Total lag of one group across every partition it has committed. */
  async getGroupLag(cluster: ClusterConfig, groupId: string): Promise<bigint> {
    const entries = await this.fetchGroupOffsets(cluster, groupId);
    return entries.reduce((sum, e) => sum + BigInt(e.lag), 0n);
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

    const groupIds = groupList.groups.map((g) => g.groupId).filter((id) => !isInternalGroup(id));
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

  // ---- Schema Registry ----------------------------------------------------------

  /**
   * The cluster's Schema Registry client, or undefined when none is set.
   * With `interactive`, asks for a missing password and saves it.
   */
  async getSchemaRegistry(cluster: ClusterConfig, interactive = false): Promise<SchemaRegistryClient | undefined> {
    const config = cluster.schemaRegistry;
    if (!config?.url) {
      return undefined;
    }
    const key = registryKey(config);
    const cached = this.registries.get(cluster.id);
    if (cached?.key === key) {
      return cached.client;
    }
    let password: string | undefined;
    if (config.username) {
      password = await this.secrets?.get(REGISTRY_SECRET_PREFIX + cluster.id);
      if (password === undefined && interactive) {
        password = await vscode.window.showInputBox({
          title: `Schema Registry for "${cluster.name}"`,
          prompt: `Password for ${config.username} (saved in VS Code's secret storage)`,
          password: true,
          ignoreFocusOut: true,
        });
        if (password !== undefined) {
          await this.secrets?.store(REGISTRY_SECRET_PREFIX + cluster.id, password);
        }
      }
    }
    const client = new SchemaRegistryClient(config.url, config.username, password);
    this.registries.set(cluster.id, { key, client });
    return client;
  }

  // ---- Producing ------------------------------------------------------------------

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

  private async toKafkaMessage(cluster: ClusterConfig, options: ProduceOptions) {
    let value: string | Buffer = options.value;
    if (options.valueSubject) {
      const registry = await this.getSchemaRegistry(cluster, true);
      if (!registry) {
        throw new Error(`"${cluster.name}" has no Schema Registry to encode with.`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(options.value);
      } catch (error) {
        throw new Error(`The value must be JSON to encode it with "${options.valueSubject}": ${(error as Error).message}`);
      }
      value = (await registry.encode(options.valueSubject, payload)).buffer;
    }
    return {
      key: options.key && options.key.length > 0 ? options.key : undefined,
      value,
      partition: options.partition,
      headers:
        options.headers && Object.keys(options.headers).length > 0
          ? options.headers
          : undefined,
    };
  }

  /** Sends one message. The producer stays connected for the next send. */
  async produce(
    cluster: ClusterConfig,
    topic: string,
    options: ProduceOptions,
  ): Promise<void> {
    await this.produceBatch(cluster, topic, [options]);
  }

  /**
   * Sends `records` in order, in chunks, reporting how many were sent so far.
   * Stops between chunks when `token` is cancelled and returns the count sent.
   */
  async produceBatch(
    cluster: ClusterConfig,
    topic: string,
    records: ProduceOptions[],
    onProgress?: (sent: number) => void,
    token?: vscode.CancellationToken,
  ): Promise<number> {
    const producer = await this.getProducer(cluster);
    let sent = 0;
    try {
      for (let i = 0; i < records.length; i += 100) {
        if (token?.isCancellationRequested) {
          break;
        }
        const chunk = records.slice(i, i + 100);
        const messages = await Promise.all(chunk.map((r) => this.toKafkaMessage(cluster, r)));
        await producer.send({ topic, messages });
        sent += chunk.length;
        onProgress?.(sent);
      }
    } catch (error) {
      if (isConnectionError(error)) {
        // Rebuild the producer next time instead of reusing a dead one.
        this.dropProducer(cluster.id);
      }
      throw error;
    }
    return sent;
  }

  // ---- Consuming -----------------------------------------------------------------

  private trackConsumer(clusterId: string, stop: () => Promise<void>): () => void {
    let set = this.consumers.get(clusterId);
    if (!set) {
      set = new Set();
      this.consumers.set(clusterId, set);
    }
    set.add(stop);
    return () => set!.delete(stop);
  }

  private async stopConsumers(clusterId: string): Promise<void> {
    const set = this.consumers.get(clusterId);
    this.consumers.delete(clusterId);
    await Promise.all([...(set ?? [])].map((stop) => stop().catch(() => undefined)));
  }

  /** A consumer in a throwaway group that never commits; deleted again by `closeTemporaryConsumer`. */
  private async temporaryConsumer(cluster: ClusterConfig, purpose: string): Promise<{ consumer: Consumer; groupId: string }> {
    const groupId = `${INTERNAL_GROUP_PREFIX}${purpose}-${crypto.randomUUID()}`;
    const consumer = (await this.getKafka(cluster)).consumer({ groupId, maxWaitTimeInMs: 1_000 });
    return { consumer, groupId };
  }

  private async closeTemporaryConsumer(cluster: ClusterConfig, consumer: Consumer, groupId: string): Promise<void> {
    await consumer.disconnect().catch(() => undefined);
    // Kafka 4's group coordinator keeps an empty group until its periodic cleanup, so
    // delete it now. Awaited (briefly) so a disconnect that follows can't abort it.
    const admin = this.admins.get(cluster.id);
    if (admin) {
      await Promise.race([
        admin.deleteGroups([groupId]).catch((error) => {
          this.log(`Couldn't delete temporary group "${groupId}": ${describeError(error)}`);
        }),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }

  private async toConsumedMessage(
    partition: number,
    message: KafkaMessage,
    format: Format,
    registry: SchemaRegistryClient | undefined,
  ): Promise<ConsumedMessage> {
    const [key, value] = await Promise.all([
      decodeField(message.key ?? null, format.key, registry),
      decodeField(message.value ?? null, format.value, registry),
    ]);
    const decodeError = [value.error && `Value: ${value.error}`, key.error && `Key: ${key.error}`].filter(Boolean).join(" ");
    return {
      partition,
      offset: message.offset,
      key: key.text,
      value: value.text,
      timestamp: message.timestamp,
      headers: decodeHeaders(message.headers),
      size: message.value?.length ?? 0,
      keyEncoding: key.encoding,
      valueEncoding: value.encoding,
      ...(key.schema ? { keySchema: key.schema } : {}),
      ...(value.schema ? { valueSchema: value.schema } : {}),
      ...(decodeError ? { decodeError } : {}),
    };
  }

  private async registryFor(cluster: ClusterConfig, format: Format): Promise<SchemaRegistryClient | undefined> {
    try {
      return await this.getSchemaRegistry(cluster, format.key !== "auto" || format.value !== "auto");
    } catch (error) {
      this.log(`Schema Registry unavailable for "${cluster.name}": ${describeError(error)}`);
      return undefined;
    }
  }

  /**
   * Starts a live tail from the latest offset. Returns a handle whose
   * `stop()` disconnects the underlying consumer. Disconnecting or removing
   * the cluster stops it too.
   */
  async startTail(
    cluster: ClusterConfig,
    topic: string,
    onMessage: (message: ConsumedMessage) => void,
    onError: (error: unknown) => void,
    format: Format = DEFAULT_FORMAT,
  ): Promise<{ stop: () => Promise<void> }> {
    this.ensureAdmin(cluster);
    const registry = await this.registryFor(cluster, format);
    const { consumer, groupId } = await this.temporaryConsumer(cluster, "tail");
    let stopped = false;
    const stop = async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      untrack();
      await this.closeTemporaryConsumer(cluster, consumer, groupId);
    };
    const untrack = this.trackConsumer(cluster.id, stop);
    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
    } catch (error) {
      await stop();
      throw error;
    }
    consumer.on(consumer.events.CRASH, (event) => {
      if (!event.payload.restart && !stopped) {
        onError(event.payload.error);
        void stop();
      }
    });
    consumer
      .run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          if (!stopped) {
            onMessage(await this.toConsumedMessage(partition, message, format, registry));
          }
        },
      })
      .catch((error) => {
        if (!stopped) {
          onError(error);
          void stop();
        }
      });

    return { stop };
  }

  /**
   * Reads messages for the message browser: the newest/oldest N per
   * partition, from an offset or a timestamp, or a page before/after what is
   * already loaded. With `search`, scans up to `scanLimit` offsets per
   * partition and keeps only matches. Uses a throwaway group that never
   * commits, so real consumer groups are never touched and nothing is left
   * behind.
   */
  async browse(
    cluster: ClusterConfig,
    topic: string,
    request: BrowseRequest,
    onProgress?: (scanned: number, matched: number) => void,
    token?: vscode.CancellationToken,
  ): Promise<BrowseResult> {
    const admin = this.ensureAdmin(cluster);
    const watermarks = await admin.fetchTopicOffsets(topic);
    if (request.partition !== undefined && !watermarks.some((w) => w.partition === request.partition)) {
      throw new Error(`"${topic}" has no partition ${request.partition}.`);
    }
    let byTimestamp: Map<number, string> | undefined;
    if (request.position.kind === "timestamp") {
      const found = await admin.fetchTopicOffsetsByTimestamp(topic, request.position.timestamp);
      byTimestamp = new Map(found.map((f) => [f.partition, f.offset]));
    }
    const query = request.search?.trim() ?? "";
    const backwards = request.position.kind === "newest" || request.position.kind === "before";
    let ranges = planRanges(watermarks, request.position, request.limit, request.partition, byTimestamp);
    if (query) {
      ranges = widenForSearch(ranges, watermarks, request.scanLimit ?? 10_000, backwards);
    }
    if (ranges.length === 0) {
      return { messages: [], scanned: 0, truncated: false };
    }

    const format = request.format ?? DEFAULT_FORMAT;
    const registry = await this.registryFor(cluster, format);
    const { consumer, groupId } = await this.temporaryConsumer(cluster, "history");
    const pending = new Map(ranges.map((r) => [r.partition, r]));
    const collected: ConsumedMessage[] = [];
    let scanned = 0;
    let truncated = false;
    let settled = false;
    let resolveDone = () => {};
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const finish = (early: boolean) => {
      if (!settled) {
        settled = true;
        truncated = early;
        resolveDone();
      }
    };
    const untrack = this.trackConsumer(cluster.id, async () => finish(true));
    const cancel = token?.onCancellationRequested(() => finish(true));
    const timeout = setTimeout(() => finish(true), query ? 60_000 : 15_000);

    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      consumer
        .run({
          autoCommit: false,
          eachBatch: async ({ batch }) => {
            const range = pending.get(batch.partition);
            if (settled || !range) {
              return;
            }
            for (const message of batch.messages) {
              const offset = BigInt(message.offset);
              if (offset < range.from) {
                continue;
              }
              if (offset >= range.to || settled) {
                break;
              }
              scanned++;
              const decoded = await this.toConsumedMessage(batch.partition, message, format, registry);
              if (!query || matchesSearch(query, decoded)) {
                collected.push(decoded);
                // Reading forward, the first `limit` matches are the answer.
                if (query && !backwards && collected.length >= request.limit) {
                  finish(false);
                  return;
                }
              }
            }
            // lastOffset() also counts compacted gaps and transaction markers.
            if (BigInt(batch.lastOffset()) + 1n >= range.to) {
              pending.delete(batch.partition);
              if (pending.size === 0) {
                finish(false);
              }
            }
            onProgress?.(scanned, collected.length);
          },
        })
        .catch((error) => {
          this.log(`Browse of "${topic}" stopped: ${describeError(error)}`);
          finish(true);
        });
      for (const r of ranges) {
        consumer.seek({ topic, partition: r.partition, offset: r.from.toString() });
      }
      await done;
    } finally {
      clearTimeout(timeout);
      cancel?.dispose();
      untrack();
      await this.closeTemporaryConsumer(cluster, consumer, groupId);
    }

    let messages = collected.sort(
      (a, b) =>
        a.partition - b.partition ||
        Number(BigInt(a.offset) - BigInt(b.offset)),
    );
    if (query && backwards && messages.length > request.limit) {
      // Reading backwards for a search, keep the newest matches.
      messages = messages
        .slice()
        .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
        .slice(0, request.limit);
    }
    return { messages, scanned, truncated };
  }

  /** The newest `limitPerPartition` messages of every partition. */
  async loadRecentMessages(
    cluster: ClusterConfig,
    topic: string,
    limitPerPartition: number,
  ): Promise<ConsumedMessage[]> {
    const { messages } = await this.browse(cluster, topic, {
      position: { kind: "newest" },
      limit: limitPerPartition,
    });
    return messages;
  }

  // ---- Misc ---------------------------------------------------------------------

  log(message: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  showOutput(): void {
    this.output.show();
  }

  dispose(): void {
    for (const id of [...this.consumers.keys()]) {
      void this.stopConsumers(id);
    }
    for (const id of [...this.producers.keys()]) {
      this.dropProducer(id);
    }
    for (const admin of this.admins.values()) {
      admin.disconnect().catch(() => undefined);
    }
    for (const listener of this.configListeners) {
      listener.dispose();
    }
    this.output.dispose();
    this._onDidChangeStatus.dispose();
    this._onDidChangeClusters.dispose();
    this._onDidLoseConnection.dispose();
  }

  /** Wraps `admin` so any call rejecting with a connection-class error marks the cluster as lost. */
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
    void this.stopConsumers(cluster.id);
    this.dropProducer(cluster.id);
    this.setStatus(cluster.id, "error");
    // notify on subscribers
    this._onDidLoseConnection.fire(cluster);
  }

  async reconnect(cluster: ClusterConfig): Promise<void> {
    await this.disconnect(cluster.id);
    await this.connect(cluster);
  }
}

function registryKey(registry: ClusterSchemaRegistry | undefined): string {
  return JSON.stringify(registry ?? null);
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
