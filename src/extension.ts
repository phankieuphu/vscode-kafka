import * as vscode from "vscode";
import { ClusterManager, describeError } from "./kafka/clusterManager";
import { ClusterConfig, ClusterSource } from "./kafka/types";
import { findLagAlert, LagMonitor, setLagAlert } from "./lagMonitor";
import { promptForSecurity } from "./securityPrompt";
import {
  AclsTreeItem,
  BrokerTreeItem,
  ClusterTreeItem,
  GroupOffsetTreeItem,
  GroupsFolderTreeItem,
  GroupTreeItem,
  KafkaTreeProvider,
  TopicsFolderTreeItem,
  TopicTreeItem,
} from "./tree/kafkaTreeProvider";
import { TopicPanel } from "./panels/topicPanel";
import { GroupPanel } from "./panels/groupPanel";
import { DashboardPanel } from "./panels/dashboardPanel";
import { BrokerPanel } from "./panels/brokerPanel";
import { AclPanel } from "./panels/aclPanel";
import { parseBrokers, validateBrokers } from "./kafka/brokers";
import { KafkaStatusBar } from "./statusBar";
import { registerAiContext } from "./ai/settings";
import { disposeAiOutputChannel } from "./ai/stream";
import { registerKafkaChat } from "./ai/chat";
import { initAiKeys } from "./ai/keys";
import { isAiReady, registerAiAvailability } from "./ai/model";
import { registerKafkaTools } from "./ai/lmTools";
import { lagAiHooks, registerAiCommands } from "./ai/commands";

const EDIT_SECURITY = "Edit Connection Security";
const EXPLAIN_WITH_AI = "Explain with AI";

export function activate(context: vscode.ExtensionContext): void {
  const manager = new ClusterManager(context.secrets);
  const treeProvider = new KafkaTreeProvider(manager);
  TopicPanel.setStorage(context.globalState);
  DashboardPanel.setState(context.globalState);

  /** The error plus the likely cause/fix manager.connect() worked out, if any. */
  const failureText = (cluster: ClusterConfig, error: unknown): string => {
    const hint = manager.getLastHint(cluster.id);
    return hint ? `${describeError(error)} — ${hint}` : describeError(error);
  };

  const showConnectFailure = async (
    cluster: ClusterConfig,
    error: unknown,
    prefix: string,
  ): Promise<void> => {
    // Without a model (or with AI off) the buttons are exactly as before.
    const ai = await isAiReady().catch(() => false);
    const choice = await vscode.window.showErrorMessage(
      `${prefix}: ${failureText(cluster, error)}`,
      ...(ai ? [EXPLAIN_WITH_AI] : []),
      EDIT_SECURITY,
      "Show Output",
    );
    if (choice === EXPLAIN_WITH_AI) {
      vscode.commands.executeCommand("kafka-manager.explainErrorWithAi", { cluster });
    } else if (choice === EDIT_SECURITY) {
      vscode.commands.executeCommand("kafka-manager.editClusterSecurity", { cluster });
    } else if (choice === "Show Output") {
      manager.showOutput();
    }
  };

  const lagMonitor: LagMonitor = new LagMonitor(manager, lagAiHooks(context, manager, () => lagMonitor));

  context.subscriptions.push(
    manager,
    initAiKeys(context.secrets),
    registerAiContext(),
    registerAiAvailability(),
    { dispose: disposeAiOutputChannel },
    new KafkaStatusBar(manager),
    lagMonitor,
    vscode.window.registerTreeDataProvider("kafkaExplorer", treeProvider),

    vscode.commands.registerCommand("kafka-manager.refresh", () =>
      treeProvider.refresh(),
    ),

    vscode.commands.registerCommand("kafka-manager.addCluster", async () => {
      const canShare = !!vscode.workspace.workspaceFolders?.length && vscode.workspace.isTrusted;
      const steps = canShare ? 4 : 3;
      const existing = new Set(manager.getClusters().map((c) => c.name));
      const name = await vscode.window.showInputBox({
        title: `Add Kafka Cluster (1/${steps})`,
        prompt: "Name shown in the Clusters view",
        placeHolder: "Local",
        ignoreFocusOut: true,
        validateInput: (v) =>
          v.trim().length === 0
            ? "Enter a name"
            : existing.has(v.trim())
              ? `A cluster named “${v.trim()}” already exists`
              : undefined,
      });
      if (!name) {
        return;
      }

      const brokersInput = await vscode.window.showInputBox({
        title: `Add Kafka Cluster (2/${steps})`,
        prompt: "Bootstrap servers as host:port, comma-separated",
        placeHolder: "localhost:9092",
        ignoreFocusOut: true,
        validateInput: validateBrokers,
      });
      if (!brokersInput) {
        return;
      }

      const brokers = parseBrokers(brokersInput);
      const security = await promptForSecurity(brokers, `Add Kafka Cluster (3/${steps})`);
      if (!security) {
        return;
      }

      let source: ClusterSource = "user";
      if (canShare) {
        const where = await vscode.window.showQuickPick(
          [
            { label: "User settings", detail: "Only you, in every workspace", source: "user" as const },
            {
              label: "Workspace settings",
              detail: "Saved in .vscode/settings.json so the team can commit and share it. Passwords stay in your secret storage.",
              source: "workspace" as const,
            },
          ],
          { title: `Add Kafka Cluster (4/${steps})`, placeHolder: "Where should this cluster be saved?", ignoreFocusOut: true },
        );
        if (!where) {
          return;
        }
        source = where.source;
      }

      let cluster: ClusterConfig;
      try {
        cluster = await manager.addCluster(name.trim(), brokers, security, source);
      } catch (error) {
        vscode.window.showErrorMessage(`Couldn't save the cluster: ${describeError(error)}`);
        return;
      }
      treeProvider.refresh();
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to "${cluster.name}"…`,
          },
          () => manager.connect(cluster),
        );
      } catch (error) {
        await showConnectFailure(
          cluster,
          error,
          `Saved "${cluster.name}", but couldn't connect`,
        );
      }
    }),

    vscode.commands.registerCommand(
      "kafka-manager.editClusterSecurity",
      async (item: { cluster: ClusterConfig }) => {
        // Re-read: the item may hold a stale copy.
        const current = manager.getCluster(item.cluster.id);
        if (!current) {
          return;
        }
        const security = await promptForSecurity(
          current.brokers,
          `Connection Security — ${current.name}`,
          current,
        );
        if (!security) {
          return;
        }
        let updated: ClusterConfig | undefined;
        try {
          updated = await manager.updateClusterSecurity(current.id, security);
        } catch (error) {
          await showConnectFailure(
            current,
            error,
            `Saved, but couldn't reconnect to "${current.name}"`,
          );
          return;
        }
        if (updated && manager.getStatus(updated.id) !== "connected") {
          try {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: `Connecting to "${updated.name}"…`,
              },
              () => manager.connect(updated!),
            );
          } catch (error) {
            await showConnectFailure(
              updated,
              error,
              `Saved, but couldn't connect to "${updated.name}"`,
            );
          }
        }
        treeProvider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.updateClusterName",
      async (item: ClusterTreeItem) => {
        const name = await vscode.window.showInputBox({
          title: "Rename Kafka Cluster",
          prompt: "Name shown in the Clusters view",
          value: item.cluster.name,
          validateInput: (v) =>
            v.trim().length === 0 ? "Enter a name" : undefined,
        });
        if (!name || name.trim() === item.cluster.name) {
          return;
        }
        await manager.updateClusterName(item.cluster.id, name.trim());
        treeProvider.refresh();
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.copyBootstrapServers",
      async (item: ClusterTreeItem) => {
        await vscode.env.clipboard.writeText(item.cluster.brokers.join(","));
        vscode.window.setStatusBarMessage(
          `Copied bootstrap servers for "${item.cluster.name}"`,
          3000,
        );
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.removeCluster",
      async (item: ClusterTreeItem) => {
        const confirm = await vscode.window.showWarningMessage(
          `Remove cluster "${item.cluster.name}"? This does not delete anything on the broker.`,
          { modal: true },
          "Remove",
        );
        if (confirm !== "Remove") {
          return;
        }
        await manager.removeCluster(item.cluster.id);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.connectCluster",
      async (item: ClusterTreeItem) => {
        try {
          await manager.connect(item.cluster);
        } catch (error) {
          await showConnectFailure(
            item.cluster,
            error,
            `Could not connect to "${item.cluster.name}"`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.disconnectCluster",
      async (item: ClusterTreeItem) => {
        await manager.disconnect(item.cluster.id);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.createTopic",
      async (item: TopicsFolderTreeItem | ClusterTreeItem) => {
        const cluster = item.cluster;
        const topic = await vscode.window.showInputBox({
          prompt: "New topic name",
        });
        if (!topic) {
          return;
        }

        const partitionsInput = await vscode.window.showInputBox({
          prompt: "Number of partitions",
          value: "1",
          validateInput: (v) =>
            Number.isInteger(Number(v)) && Number(v) > 0
              ? undefined
              : "Enter a positive integer",
        });
        if (!partitionsInput) {
          return;
        }

        const replicationInput = await vscode.window.showInputBox({
          prompt: "Replication factor",
          value: "1",
          validateInput: (v) =>
            Number.isInteger(Number(v)) && Number(v) > 0
              ? undefined
              : "Enter a positive integer",
        });
        if (!replicationInput) {
          return;
        }

        const settings = await promptForTopicSettings();
        if (!settings) {
          return;
        }

        try {
          await manager.createTopic(
            cluster,
            topic,
            Number(partitionsInput),
            Number(replicationInput),
            settings,
          );
          vscode.window.showInformationMessage(`Topic "${topic}" created.`);
          treeProvider.refresh();
        } catch (error) {
          manager.log(
            `Failed to create topic "${topic}" on cluster "${cluster.name}": ${describeError(error)}`,
          );
          vscode.window.showErrorMessage(
            `Failed to create topic: ${describeError(error)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.deleteTopic",
      async (item: TopicTreeItem) => {
        const confirm = await vscode.window.showWarningMessage(
          `Delete topic "${item.topic.name}"? This cannot be undone.`,
          { modal: true },
          "Delete",
        );
        if (confirm !== "Delete") {
          return;
        }
        try {
          await manager.deleteTopic(item.cluster, item.topic.name);
          treeProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to delete topic: ${describeError(error)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.viewTopic",
      (item: TopicTreeItem) => {
        TopicPanel.createOrShow(manager, item.cluster, item.topic.name);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.produceMessage",
      (item: TopicTreeItem) => {
        TopicPanel.createOrShow(manager, item.cluster, item.topic.name);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.deleteConsumerGroup",
      async (item: GroupTreeItem) => {
        const confirm = await vscode.window.showWarningMessage(
          `Delete consumer group "${item.group.groupId}"?`,
          { modal: true },
          "Delete",
        );
        if (confirm !== "Delete") {
          return;
        }
        try {
          await manager.deleteConsumerGroup(item.cluster, item.group.groupId);
          treeProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to delete consumer group: ${describeError(error)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.createConsumerGroup",
      async (item: GroupsFolderTreeItem) => {
        const cluster = item.cluster;
        const groupId = await vscode.window.showInputBox({
          prompt: "New consumer group ID",
        });
        if (!groupId) {
          return;
        }

        let topics;
        try {
          topics = await manager.listTopics(cluster);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to list topics: ${describeError(error)}`,
          );
          return;
        }
        if (topics.length === 0) {
          vscode.window.showErrorMessage(
            "This cluster has no topics to subscribe the new group to.",
          );
          return;
        }

        const topic = await vscode.window.showQuickPick(
          topics.map((t) => t.name),
          { placeHolder: "Topic for the new group to subscribe to" },
        );
        if (!topic) {
          return;
        }

        const fromBeginning = await vscode.window.showQuickPick(["Yes", "No"], {
          placeHolder:
            "Consume from the beginning? (recommended — Kafka only keeps a group once it has committed an offset)",
        });
        if (!fromBeginning) {
          return;
        }

        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Creating consumer group "${groupId}"...`,
            },
            () =>
              manager.createConsumerGroup(
                cluster,
                groupId,
                topic,
                fromBeginning === "Yes",
              ),
          );
          vscode.window.showInformationMessage(
            `Consumer group "${groupId}" created.`,
          );
          treeProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to create consumer group: ${describeError(error)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.viewConsumerGroup",
      (item: GroupTreeItem) => {
        GroupPanel.createOrShow(manager, item.cluster, item.group.groupId);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.resetGroupOffsets",
      async (item: GroupTreeItem) => {
        const cluster = item.cluster;
        const groupId = item.group.groupId;

        let offsets;
        try {
          offsets = await manager.fetchGroupOffsets(cluster, groupId);
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to load group offsets: ${describeError(error)}`,
          );
          return;
        }
        const topics = [...new Set(offsets.map((o) => o.topic))];
        if (topics.length === 0) {
          vscode.window.showErrorMessage(
            `"${groupId}" has no committed offsets to reset.`,
          );
          return;
        }

        const topic = await vscode.window.showQuickPick(topics, {
          placeHolder: "Topic to reset offsets for",
        });
        if (!topic) {
          return;
        }

        const position = await vscode.window.showQuickPick(
          ["Earliest", "Latest"],
          {
            placeHolder: `Reset "${groupId}" / "${topic}" offsets to...`,
          },
        );
        if (!position) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Reset all partitions of "${topic}" for group "${groupId}" to ${position.toLowerCase()}? This requires the group to have no active members.`,
          { modal: true },
          "Reset",
        );
        if (confirm !== "Reset") {
          return;
        }

        try {
          await manager.resetGroupOffsets(
            cluster,
            groupId,
            topic,
            position === "Earliest" ? "earliest" : "latest",
          );
          vscode.window.showInformationMessage(
            `Reset "${topic}" offsets for "${groupId}" to ${position.toLowerCase()}.`,
          );
          treeProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to reset offsets: ${describeError(error)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.editGroupOffset",
      async (item: GroupOffsetTreeItem) => {
        const cluster = item.cluster;
        const { topic, partition } = item.entry;
        const groupId = item.groupId;

        const choice = await vscode.window.showQuickPick(
          ["Earliest", "Latest", "Custom offset..."],
          {
            placeHolder: `Set offset for "${topic}" partition ${partition}`,
          },
        );
        if (!choice) {
          return;
        }

        let apply: () => Promise<void>;
        let describeTarget: string;

        if (choice === "Custom offset...") {
          const value = await vscode.window.showInputBox({
            prompt: `New offset for "${topic}" partition ${partition}`,
            value: item.entry.offset,
            validateInput: (v) =>
              /^\d+$/.test(v)
                ? undefined
                : "Enter a non-negative integer offset",
          });
          if (!value) {
            return;
          }
          apply = () =>
            manager.setGroupOffset(cluster, groupId, topic, partition, value);
          describeTarget = value;
        } else {
          const edge = choice === "Earliest" ? "earliest" : "latest";
          apply = () =>
            manager.setGroupOffsetToEdge(
              cluster,
              groupId,
              topic,
              partition,
              edge,
            );
          describeTarget = edge;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Set offset for "${topic}" partition ${partition} (group "${groupId}") to ${describeTarget}? This requires the group to have no active members.`,
          { modal: true },
          "Set Offset",
        );
        if (confirm !== "Set Offset") {
          return;
        }

        try {
          await apply();
          vscode.window.showInformationMessage(
            `Offset updated for "${topic}" partition ${partition}.`,
          );
          treeProvider.refresh();
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to set offset: ${describeError(error)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.openDashboard",
      async (item?: ClusterTreeItem) => {
        let cluster = item?.cluster;
        if (!cluster) {
          const clusters = manager.getClusters();
          if (clusters.length === 0) {
            vscode.window.showInformationMessage(
              "No Kafka clusters configured. Add one first.",
            );
            return;
          }
          const picked = await vscode.window.showQuickPick(
            clusters.map((c) => ({
              label: c.name,
              description: c.brokers.join(", "),
              detail: manager.getStatus(c.id),
              cluster: c,
            })),
            { placeHolder: "Select a cluster to open its dashboard" },
          );
          cluster = picked?.cluster;
        }
        if (!cluster) {
          return;
        }
        if (manager.getStatus(cluster.id) !== "connected") {
          try {
            await manager.connect(cluster);
          } catch (error) {
            await showConnectFailure(
              cluster,
              error,
              `Failed to connect to "${cluster.name}"`,
            );
            return;
          }
        }
        DashboardPanel.createOrShow(manager, cluster);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.viewBroker",
      (item: BrokerTreeItem) => {
        BrokerPanel.createOrShow(manager, item.cluster, item.broker.nodeId);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.viewAcls",
      (item: AclsTreeItem | ClusterTreeItem) => {
        AclPanel.createOrShow(manager, item.cluster);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.watchGroupLag",
      async (item: { cluster: ClusterConfig; group: { groupId: string } }) => {
        const groupId = item.group.groupId;
        const current = findLagAlert(item.cluster, groupId);
        const input = await vscode.window.showInputBox({
          title: `Watch lag of "${groupId}"`,
          prompt: "Notify when the group's total lag goes above this many messages (checked while the cluster is connected)",
          value: String(current?.threshold ?? 1000),
          validateInput: (v) =>
            Number.isInteger(Number(v)) && Number(v) >= 0 ? undefined : "Enter a whole number of messages",
        });
        if (input === undefined) {
          return;
        }
        await setLagAlert(item.cluster, groupId, Number(input));
        vscode.window.setStatusBarMessage(`Watching lag of "${groupId}" (alert above ${Number(input).toLocaleString()})`, 4000);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.unwatchGroupLag",
      async (item: GroupTreeItem) => {
        await setLagAlert(item.cluster, item.group.groupId, undefined);
      },
    ),

    vscode.commands.registerCommand(
      "kafka-manager.configureSchemaRegistry",
      async (item: ClusterTreeItem) => {
        const current = manager.getCluster(item.cluster.id);
        if (!current) {
          return;
        }
        const title = `Schema Registry — ${current.name}`;
        const url = await vscode.window.showInputBox({
          title,
          prompt: "Schema Registry URL — leave empty to remove it",
          placeHolder: "http://localhost:8081 or https://psrc-xxxx.us-east-2.aws.confluent.cloud",
          value: current.schemaRegistry?.url ?? "",
          ignoreFocusOut: true,
          validateInput: (v) => {
            if (!v.trim()) {
              return undefined;
            }
            try {
              const parsed = new URL(v.trim());
              return /^https?:$/.test(parsed.protocol) ? undefined : "Use an http:// or https:// URL";
            } catch {
              return "Enter a URL such as http://localhost:8081";
            }
          },
        });
        if (url === undefined) {
          return;
        }
        if (!url.trim()) {
          await manager.updateSchemaRegistry(current.id, undefined);
          vscode.window.setStatusBarMessage(`Removed the Schema Registry from "${current.name}"`, 3000);
          return;
        }
        const username = await vscode.window.showInputBox({
          title,
          prompt: "Username (Confluent Cloud: the Schema Registry API key) — leave empty if the registry has no authentication",
          value: current.schemaRegistry?.username ?? "",
          ignoreFocusOut: true,
        });
        if (username === undefined) {
          return;
        }
        let password: string | undefined;
        if (username.trim()) {
          const keep = current.schemaRegistry?.username === username.trim();
          password = await vscode.window.showInputBox({
            title,
            prompt: keep
              ? "Password — leave empty to keep the saved one. Stored in VS Code's secret storage."
              : "Password — stored in VS Code's secret storage, not settings.json.",
            password: true,
            ignoreFocusOut: true,
          });
          if (password === undefined) {
            return;
          }
          if (keep && password === "") {
            password = undefined;
          }
        }
        await manager.updateSchemaRegistry(
          current.id,
          { url: url.trim(), ...(username.trim() ? { username: username.trim() } : {}) },
          password,
        );
        vscode.window.setStatusBarMessage(`Schema Registry set for "${current.name}"`, 3000);
      },
    ),

    vscode.commands.registerCommand("kafka-manager.showOutput", () =>
      manager.showOutput(),
    ),

    registerAiCommands(context, manager, lagMonitor),
    registerKafkaChat(context, manager),
    registerKafkaTools(manager),

    vscode.commands.registerCommand(
      "kafka-manager.reconnectCluster",
      async (item: ClusterTreeItem) => {
        try {
          await manager.reconnect(item.cluster);
        } catch (error) {
          await showConnectFailure(
            item.cluster,
            error,
            `Could not reconnect to "${item.cluster.name}"`,
          );
        }
      },
    ),

    manager.onDidLoseConnection(async (cluster) => {
      const hint = manager.getLastHint(cluster.id);
      const choice = await vscode.window.showWarningMessage(
        `Lost connection to "${cluster.name}": ${manager.getLastError(cluster.id)}${hint ? ` — ${hint}` : ""}`,
        "Reconnect",
      );
      if (choice === "Reconnect") {
        vscode.commands.executeCommand("kafka-manager.reconnectCluster", {
          cluster,
        });
      }
    }),
  );
}

/** Optional retention/cleanup settings for a new topic; `undefined` when cancelled. */
async function promptForTopicSettings(): Promise<Record<string, string> | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Use broker defaults", custom: false },
      { label: "Set retention and cleanup policy…", detail: "retention.ms and cleanup.policy", custom: true },
    ],
    { placeHolder: "Topic settings" },
  );
  if (!choice) {
    return undefined;
  }
  if (!choice.custom) {
    return {};
  }
  const policy = await vscode.window.showQuickPick(
    [
      { label: "delete", detail: "Drop old segments after the retention period (default)" },
      { label: "compact", detail: "Keep the latest value per key" },
      { label: "compact,delete", detail: "Compact, and also drop segments past retention" },
    ],
    { placeHolder: "cleanup.policy" },
  );
  if (!policy) {
    return undefined;
  }
  const retention = await vscode.window.showInputBox({
    prompt: "retention.ms — e.g. 604800000 for 7 days, -1 to keep forever, empty for the broker default",
    validateInput: (v) => (v.trim() === "" || /^-1$|^\d+$/.test(v.trim()) ? undefined : "Enter milliseconds, -1, or leave empty"),
  });
  if (retention === undefined) {
    return undefined;
  }
  return {
    "cleanup.policy": policy.label,
    ...(retention.trim() ? { "retention.ms": retention.trim() } : {}),
  };
}

export function deactivate(): void {
  // Cluster admin connections are closed via the ClusterManager's
  // Disposable registration in `activate`.
}
