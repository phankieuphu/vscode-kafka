import * as vscode from "vscode";
import { ClusterManager, describeError } from "./kafka/clusterManager";
import { DetectedIssue, detectIssues, diffIssues, ScanMemory } from "./kafka/issueRules";
import { ClusterConfig } from "./kafka/types";

const SECTION = "kafka.devMode";
export const DEV_MODE_CONTEXT = "kafka-manager.devMode";

export interface DevModeSettings {
  enabled: boolean;
  intervalSeconds: number;
  notify: boolean;
  ignoredRules: Set<string>;
}

export function getDevModeSettings(): DevModeSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const ignored = config.get<string[]>("ignoredRules", []);
  return {
    enabled: config.get<boolean>("enabled", false),
    intervalSeconds: Math.max(10, config.get<number>("scanIntervalSeconds", 30)),
    notify: config.get<boolean>("notify", true),
    ignoredRules: new Set(Array.isArray(ignored) ? ignored : []),
  };
}

const ICON: Record<DetectedIssue["level"], string> = { crit: "$(error)", warn: "$(warning)", info: "$(info)" };
const LABEL: Record<DetectedIssue["level"], string> = { crit: "CRITICAL", warn: "WARNING", info: "NOTE" };

interface ClusterScan {
  cluster: ClusterConfig;
  issues: DetectedIssue[];
  memory: ScanMemory;
  at: Date;
}

/**
 * Dev mode (`kafka.devMode.enabled`): scans every connected cluster on a
 * timer, logs issues as they appear and clear, notifies about new problems
 * and keeps a count in the status bar.
 */
export class DevModeMonitor implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("kafka-manager.devMode", vscode.StatusBarAlignment.Left, 48);
  private readonly subscriptions: vscode.Disposable[];
  private readonly scans = new Map<string, ClusterScan>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly manager: ClusterManager,
    /** Whether "Diagnose with AI" can be offered. */
    private readonly aiReady: () => Promise<boolean> = async () => false,
  ) {
    this.item.name = "Kafka Dev Mode";
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SECTION)) {
          this.schedule();
        }
      }),
      manager.onDidChangeStatus((id) => {
        if (manager.getStatus(id) === "connected") {
          void this.scan();
        } else if (this.scans.delete(id)) {
          this.update();
        }
      }),
      manager.onDidChangeClusters(() => {
        const ids = new Set(manager.getClusters().map((c) => c.id));
        for (const id of this.scans.keys()) {
          if (!ids.has(id)) {
            this.scans.delete(id);
          }
        }
        this.update();
      }),
    ];
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const settings = getDevModeSettings();
    void vscode.commands.executeCommand("setContext", DEV_MODE_CONTEXT, settings.enabled);
    if (!settings.enabled) {
      this.scans.clear();
      this.update();
      return;
    }
    this.timer = setInterval(() => void this.scan(), settings.intervalSeconds * 1000);
    void this.scan();
  }

  /** Scans every connected cluster now; resolves when done (or joins a scan in progress). */
  scan(): Promise<void> {
    if (!this.running) {
      this.running = this.scanAll().finally(() => (this.running = undefined));
    }
    return this.running;
  }

  private async scanAll(): Promise<void> {
    const settings = getDevModeSettings();
    if (!settings.enabled) {
      return;
    }
    const connected = this.manager.getClusters().filter((c) => this.manager.getStatus(c.id) === "connected");
    await Promise.all(connected.map((c) => this.scanCluster(c, settings)));
    this.update();
  }

  private async scanCluster(cluster: ClusterConfig, settings: DevModeSettings): Promise<void> {
    let raw;
    try {
      raw = await this.manager.getClusterSnapshot(cluster);
    } catch (error) {
      this.manager.log(`Dev mode: couldn't scan "${cluster.name}": ${describeError(error)}`);
      return;
    }
    const before = this.scans.get(cluster.id);
    const { issues, memory } = detectIssues(raw, before?.memory, settings.ignoredRules);
    this.scans.set(cluster.id, { cluster, issues, memory, at: new Date() });
    const { added, resolved } = diffIssues(before?.issues ?? [], issues);
    for (const issue of added) {
      this.manager.log(`Dev mode: [${cluster.name}] ${LABEL[issue.level]} ${issue.text} ${issue.hint}`);
    }
    for (const issue of resolved) {
      this.manager.log(`Dev mode: [${cluster.name}] resolved: ${issue.text}`);
    }
    const alarming = added.filter((i) => i.level !== "info");
    if (settings.notify && alarming.length > 0) {
      void this.notify(cluster, alarming);
    }
  }

  private async notify(cluster: ClusterConfig, added: DetectedIssue[]): Promise<void> {
    const [first] = added;
    const more = added.length > 1 ? ` (+${added.length - 1} more)` : "";
    const ai = await this.aiReady().catch(() => false);
    const actions = ["Show Issues", ...(ai ? ["Diagnose with AI"] : []), "Turn Off Dev Mode"];
    const show = first.level === "crit" ? vscode.window.showErrorMessage : vscode.window.showWarningMessage;
    const choice = await show(`Kafka dev mode on "${cluster.name}": ${first.text}${more}`, ...actions);
    if (choice === "Show Issues") {
      void this.showIssues(cluster.id);
    } else if (choice === "Diagnose with AI") {
      void vscode.commands.executeCommand("kafka-manager.diagnoseWithAi", { cluster });
    } else if (choice === "Turn Off Dev Mode") {
      void setDevModeEnabled(false);
    }
  }

  /** Current issues of every scanned cluster, or one. */
  getIssues(clusterId?: string): Array<{ cluster: ClusterConfig; issue: DetectedIssue }> {
    return [...this.scans.values()]
      .filter((s) => !clusterId || s.cluster.id === clusterId)
      .flatMap((s) => s.issues.map((issue) => ({ cluster: s.cluster, issue })));
  }

  /** Quick pick of current issues; picking one opens the topic, group or dashboard it's about. */
  async showIssues(clusterId?: string): Promise<void> {
    if (!getDevModeSettings().enabled) {
      const choice = await vscode.window.showInformationMessage(
        "Dev mode is off. Turn it on to scan connected clusters for common Kafka issues?",
        "Turn On",
      );
      if (choice === "Turn On") {
        await setDevModeEnabled(true);
      }
      return;
    }
    await this.scan();
    const found = this.getIssues(clusterId);
    if (found.length === 0) {
      const scanned = this.scans.size;
      void vscode.window.showInformationMessage(
        scanned === 0 ? "Dev mode: no connected cluster to scan." : `Dev mode: no issues found on ${scanned === 1 ? "the connected cluster" : `${scanned} clusters`}.`,
      );
      return;
    }
    type Pick = vscode.QuickPickItem & { cluster?: ClusterConfig; issue?: DetectedIssue };
    const items: Pick[] = [];
    let last: string | undefined;
    for (const { cluster, issue } of found) {
      if (cluster.id !== last) {
        items.push({ label: cluster.name, kind: vscode.QuickPickItemKind.Separator });
        last = cluster.id;
      }
      items.push({ label: `${ICON[issue.level]} ${issue.text}`, detail: issue.hint, cluster, issue });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: `Kafka Dev Mode: ${found.length} issue${found.length === 1 ? "" : "s"}`,
      placeHolder: "Pick an issue to open what it's about",
      matchOnDetail: true,
    });
    if (picked?.cluster && picked.issue) {
      openIssue(picked.cluster, picked.issue);
    }
  }

  private update(): void {
    const enabled = getDevModeSettings().enabled;
    if (!enabled || this.scans.size === 0) {
      this.item.hide();
      return;
    }
    const found = this.getIssues();
    const alarming = found.filter((f) => f.issue.level !== "info").length;
    const crit = found.some((f) => f.issue.level === "crit");
    this.item.text = found.length === 0 ? "$(bug) Dev: no issues" : `$(bug) Dev: ${found.length} issue${found.length === 1 ? "" : "s"}`;
    this.item.backgroundColor =
      alarming === 0 ? undefined : new vscode.ThemeColor(crit ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground");
    const last = new Date(Math.max(...[...this.scans.values()].map((s) => s.at.getTime())));
    this.item.tooltip = `Kafka dev mode scanned ${this.scans.size === 1 ? "1 cluster" : `${this.scans.size} clusters`} (last at ${last.toLocaleTimeString()}).\nClick to list issues.`;
    this.item.command = "kafka-manager.showDetectedIssues";
    this.item.show();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.item.dispose();
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }
}

function openIssue(cluster: ClusterConfig, issue: DetectedIssue): void {
  if (issue.group) {
    void vscode.commands.executeCommand("kafka-manager.viewConsumerGroup", { cluster, group: { groupId: issue.group } });
  } else if (issue.topic) {
    void vscode.commands.executeCommand("kafka-manager.viewTopic", { cluster, topic: { name: issue.topic } });
  } else {
    void vscode.commands.executeCommand("kafka-manager.openDashboard", { cluster });
  }
}

/** Turns dev mode on or off in user settings, unless a workspace setting overrides it. */
export async function setDevModeEnabled(enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const target =
    config.inspect<boolean>("enabled")?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await config.update("enabled", enabled, target);
  void vscode.window.setStatusBarMessage(`Kafka dev mode ${enabled ? "on: scanning connected clusters for issues" : "off"}`, 4000);
}
