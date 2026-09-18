import * as vscode from "vscode";
import { ClusterManager, describeError } from "./kafka/clusterManager";
import {
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

export function activate(context: vscode.ExtensionContext): void {
  const manager = new ClusterManager();
  const treeProvider = new KafkaTreeProvider(manager);

  context.subscriptions.push(
    manager,
    vscode.window.registerTreeDataProvider("kafkaExplorer", treeProvider),

    vscode.commands.registerCommand("kafka-manager.refresh", () =>
      treeProvider.refresh(),
    ),

    vscode.commands.registerCommand("kafka-manager.addCluster", async () => {
      const name = await vscode.window.showInputBox({
        prompt: "Name for this Kafka cluster",
        placeHolder: "Local",
      });
      if (!name) {
        return;
      }

      const brokersInput = await vscode.window.showInputBox({
        prompt: "Broker addresses (comma-separated)",
        placeHolder: "localhost:9092",
      });
      if (!brokersInput) {
        return;
      }

      const brokers = brokersInput
        .split(",")
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
      if (brokers.length === 0) {
        vscode.window.showErrorMessage(
          "At least one broker address is required.",
        );
        return;
      }

      await manager.addCluster(name, brokers);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand(
      "kafka-manager.updateClusterName",
      async (item: ClusterTreeItem) => {
        if (!item.id) {
          vscode.window.showErrorMessage("Please choose correct cluster");
          return;
        }
        const name = await vscode.window.showInputBox({
          prompt: "Name for this Kafka cluster",
          placeHolder: "Local",
        });
        if (!name) {
          vscode.window.showErrorMessage("Please input new name for cluster");
          return;
        }

        // const brokersInput = await vscode.window.showInputBox({
        //   prompt: "Broker addresses (comma-separated)",
        //   placeHolder: "localhost:9092",
        // });
        // if (!brokersInput) {
        //   return;
        // }

        // const brokers = brokersInput
        //   .split(",")
        //   .map((b) => b.trim())
        //   .filter((b) => b.length > 0);
        // if (brokers.length === 0) {
        //   vscode.window.showErrorMessage(
        //     "At least one broker address is required.",
        //   );
        //   return;
        // }

        await manager.updateClusterName(item.id, name);
        treeProvider.refresh();
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
          vscode.window.showErrorMessage(
            `Could not connect to "${item.cluster.name}": ${describeError(error)}`,
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

        try {
          await manager.createTopic(
            cluster,
            topic,
            Number(partitionsInput),
            Number(replicationInput),
          );
          vscode.window.showInformationMessage(`Topic "${topic}" created.`);
          treeProvider.refresh();
        } catch (error) {
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

    vscode.commands.registerCommand("kafka-manager.showOutput", () =>
      manager.showOutput(),
    ),
  );
}

export function deactivate(): void {
  // Cluster admin connections are closed via the ClusterManager's
  // Disposable registration in `activate`.
}
