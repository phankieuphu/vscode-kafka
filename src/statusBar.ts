import * as vscode from "vscode";
import { ClusterManager } from "./kafka/clusterManager";
import { onDidReportHealth } from "./panels/dashboardPanel";

export class KafkaStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("kafka-manager.status", vscode.StatusBarAlignment.Left, 50);
  private readonly issues = new Map<string, number>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly manager: ClusterManager) {
    this.item.name = "Kafka Manager";
    this.subscriptions = [
      manager.onDidChangeStatus((id) => {
        if (manager.getStatus(id) !== "connected") {
          this.issues.delete(id);
        }
        this.update();
      }),
      manager.onDidChangeClusters(() => this.update()),
      onDidReportHealth(({ clusterId, issues }) => {
        this.issues.set(clusterId, issues);
        this.update();
      }),
    ];
    this.update();
  }

  private update(): void {
    const connected = this.manager.getClusters().filter((c) => this.manager.getStatus(c.id) === "connected");
    if (connected.length === 0) {
      this.item.hide();
      return;
    }
    const issueCount = connected.reduce((sum, c) => sum + (this.issues.get(c.id) ?? 0), 0);
    const label = connected.length === 1 ? `Kafka: ${connected[0].name}` : `Kafka: ${connected.length} clusters`;
    this.item.text = issueCount > 0 ? `$(warning) ${label} · ${issueCount} issue${issueCount === 1 ? "" : "s"}` : `$(pass-filled) ${label}`;
    this.item.backgroundColor = issueCount > 0 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.item.tooltip = `Connected: ${connected.map((c) => c.name).join(", ")}\nClick to open the cluster dashboard`;
    this.item.command = {
      title: "Open Cluster Dashboard",
      command: "kafka-manager.openDashboard",
      arguments: connected.length === 1 ? [{ cluster: connected[0] }] : [],
    };
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}
