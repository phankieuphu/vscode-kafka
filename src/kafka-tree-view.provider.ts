import * as vscode from "vscode";

export class KafkaTreeViewProvider
  implements vscode.TreeDataProvider<KafkaTreeItem>
{
  private _onDidChangeTreeData: vscode.EventEmitter<
    KafkaTreeItem | undefined | void
  > = new vscode.EventEmitter<KafkaTreeItem | undefined | void>();
  readonly onDidChangeTreeData: vscode.Event<KafkaTreeItem | undefined | void> =
    this._onDidChangeTreeData.event;

  private topics: string[] = [];

  constructor(private refreshTopics: () => Promise<string[]>) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async getChildren(element?: KafkaTreeItem): Promise<KafkaTreeItem[]> {
    if (!element) {
      // Fetch topics if at the root level
      this.topics = await this.refreshTopics();
      return this.topics.map(
        (topic) =>
          new KafkaTreeItem(topic, vscode.TreeItemCollapsibleState.None, {
            command: "kafka-manager.viewTopic",
            title: "View Topic",
            arguments: [topic],
          })
      );
    }
    return [];
  }

  getTreeItem(element: KafkaTreeItem): vscode.TreeItem {
    return element;
  }
}

class KafkaTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.tooltip = `Topic: ${this.label}`;
    this.contextValue = "kafkaTopic";
  }
}
