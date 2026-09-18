import * as vscode from "vscode";
import { GroupOverview } from "kafkajs";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig, GroupOffsetEntry, PartitionInfo, TopicInfo } from "../kafka/types";

export class ClusterTreeItem extends vscode.TreeItem {
  readonly kind = "cluster" as const;
  constructor(readonly cluster: ClusterConfig, status: string) {
    super(cluster.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${cluster.brokers.join(", ")} (${status})`;
    this.contextValue = `kafkaCluster-${status}`;
    this.iconPath = clusterIcon(status);
    if (status !== "connected") {
      this.collapsibleState = vscode.TreeItemCollapsibleState.None;
    }
    if (status === "disconnected" || status === "error") {
      this.command = {
        command: "kafka-manager.connectCluster",
        title: "Connect",
        arguments: [this],
      };
    }
  }
}

function clusterIcon(status: string): vscode.ThemeIcon {
  switch (status) {
    case "connected":
      return new vscode.ThemeIcon("vm-active", new vscode.ThemeColor("charts.green"));
    case "connecting":
      return new vscode.ThemeIcon("sync~spin");
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    default:
      return new vscode.ThemeIcon("vm-outline");
  }
}

export class TopicsFolderTreeItem extends vscode.TreeItem {
  readonly kind = "topicsFolder" as const;
  constructor(readonly cluster: ClusterConfig) {
    super("Topics", vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "kafkaTopicsFolder";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class GroupsFolderTreeItem extends vscode.TreeItem {
  readonly kind = "groupsFolder" as const;
  constructor(readonly cluster: ClusterConfig) {
    super("Consumer Groups", vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "kafkaGroupsFolder";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class TopicTreeItem extends vscode.TreeItem {
  readonly kind = "topic" as const;
  constructor(readonly cluster: ClusterConfig, readonly topic: TopicInfo) {
    super(topic.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${topic.partitions.length} partition${topic.partitions.length === 1 ? "" : "s"}`;
    this.contextValue = "kafkaTopic";
    this.iconPath = new vscode.ThemeIcon("list-unordered");
    this.command = {
      command: "kafka-manager.viewTopic",
      title: "Browse Messages",
      arguments: [this],
    };
  }
}

export class PartitionTreeItem extends vscode.TreeItem {
  readonly kind = "partition" as const;
  constructor(
    readonly cluster: ClusterConfig,
    readonly topicName: string,
    readonly partition: PartitionInfo
  ) {
    super(`Partition ${partition.partitionId}`, vscode.TreeItemCollapsibleState.None);
    this.description = `leader: ${partition.leader}, replicas: [${partition.replicas.join(", ")}], isr: [${partition.isr.join(", ")}]`;
    this.contextValue = "kafkaPartition";
    this.iconPath = new vscode.ThemeIcon("circle-small-filled");
  }
}

export class GroupTreeItem extends vscode.TreeItem {
  readonly kind = "group" as const;
  constructor(readonly cluster: ClusterConfig, readonly group: GroupOverview) {
    super(group.groupId, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "kafkaGroup";
    this.iconPath = new vscode.ThemeIcon("organization");
    this.command = {
      command: "kafka-manager.viewConsumerGroup",
      title: "View Group Details",
      arguments: [this],
    };
  }
}

export class GroupOffsetTreeItem extends vscode.TreeItem {
  readonly kind = "groupOffset" as const;
  constructor(readonly cluster: ClusterConfig, readonly groupId: string, readonly entry: GroupOffsetEntry) {
    super(`${entry.topic} - partition ${entry.partition}`, vscode.TreeItemCollapsibleState.None);
    this.description = `offset ${entry.offset} / high ${entry.high} (lag ${entry.lag})`;
    this.contextValue = "kafkaGroupOffset";
    const hasLag = entry.lag !== "0";
    this.iconPath = new vscode.ThemeIcon(
      hasLag ? "warning" : "check",
      hasLag ? new vscode.ThemeColor("charts.yellow") : new vscode.ThemeColor("charts.green")
    );
  }
}

export class MessageTreeItem extends vscode.TreeItem {
  readonly kind = "message" as const;
  constructor(text: string) {
    super(text, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "kafkaMessage";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

export type KafkaTreeNode =
  | ClusterTreeItem
  | TopicsFolderTreeItem
  | GroupsFolderTreeItem
  | TopicTreeItem
  | PartitionTreeItem
  | GroupTreeItem
  | GroupOffsetTreeItem
  | MessageTreeItem;

export class KafkaTreeProvider implements vscode.TreeDataProvider<KafkaTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    KafkaTreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly manager: ClusterManager) {
    manager.onDidChangeStatus(() => this.refresh());
    manager.onDidChangeClusters(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: KafkaTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: KafkaTreeNode): Promise<KafkaTreeNode[]> {
    try {
      if (!element) {
        return this.manager
          .getClusters()
          .map((cluster) => new ClusterTreeItem(cluster, this.manager.getStatus(cluster.id)));
      }

      switch (element.kind) {
        case "cluster":
          return [new TopicsFolderTreeItem(element.cluster), new GroupsFolderTreeItem(element.cluster)];

        case "topicsFolder": {
          const topics = await this.manager.listTopics(element.cluster);
          if (topics.length === 0) {
            return [new MessageTreeItem("No topics")];
          }
          return topics.map((topic) => new TopicTreeItem(element.cluster, topic));
        }

        case "topic":
          return element.topic.partitions.map(
            (partition) => new PartitionTreeItem(element.cluster, element.topic.name, partition)
          );

        case "groupsFolder": {
          const groups = await this.manager.listConsumerGroups(element.cluster);
          if (groups.length === 0) {
            return [new MessageTreeItem("No consumer groups")];
          }
          return groups.map((group) => new GroupTreeItem(element.cluster, group));
        }

        case "group": {
          const entries = await this.manager.fetchGroupOffsets(element.cluster, element.group.groupId);
          if (entries.length === 0) {
            return [new MessageTreeItem("No committed offsets")];
          }
          return entries.map(
            (entry) => new GroupOffsetTreeItem(element.cluster, element.group.groupId, entry)
          );
        }

        default:
          return [];
      }
    } catch (error) {
      this.manager.log(`Failed to load tree children: ${describeError(error)}`);
      return [new MessageTreeItem(`Error: ${describeError(error)}`)];
    }
  }
}
