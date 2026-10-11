import * as vscode from "vscode";
import { ClusterManager, describeError } from "./kafka/clusterManager";
import { ClusterConfig, LagAlert } from "./kafka/types";

const ALERTS_KEY = "lagAlerts";
const INTERVAL_KEY = "lagAlertIntervalSeconds";

export interface LagReading {
  key: string;
  lag: bigint;
  threshold: bigint;
}

/**
 * Which watched groups just crossed their threshold and which recovered,
 * given those already over it. A group is over when lag > threshold.
 */
export function evaluateLag(
  readings: LagReading[],
  alreadyOver: ReadonlySet<string>,
): { over: Set<string>; crossed: string[]; recovered: string[] } {
  const over = new Set<string>();
  for (const r of readings) {
    if (r.lag > r.threshold) {
      over.add(r.key);
    }
  }
  const measured = new Set(readings.map((r) => r.key));
  return {
    over,
    crossed: [...over].filter((k) => !alreadyOver.has(k)),
    // Groups not measured this round (cluster disconnected, alert removed) count as recovered.
    recovered: [...alreadyOver].filter((k) => !over.has(k) || !measured.has(k)),
  };
}

export function getLagAlerts(): LagAlert[] {
  const alerts = vscode.workspace.getConfiguration("kafka").get<LagAlert[]>(ALERTS_KEY, []);
  return Array.isArray(alerts) ? alerts.filter((a) => a && a.group && a.cluster && Number.isFinite(a.threshold)) : [];
}

export function findLagAlert(cluster: ClusterConfig, groupId: string): LagAlert | undefined {
  return getLagAlerts().find((a) => a.group === groupId && (a.cluster === cluster.id || a.cluster === cluster.name));
}

/** Adds, replaces (`threshold` set) or removes (`threshold` undefined) the alert for a group, in user settings. */
export async function setLagAlert(cluster: ClusterConfig, groupId: string, threshold: number | undefined): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("kafka");
  const current = configuration.inspect<LagAlert[]>(ALERTS_KEY)?.globalValue ?? [];
  const others = current.filter((a) => !(a.group === groupId && (a.cluster === cluster.id || a.cluster === cluster.name)));
  const next = threshold === undefined ? others : [...others, { cluster: cluster.id, group: groupId, threshold }];
  await configuration.update(ALERTS_KEY, next, vscode.ConfigurationTarget.Global);
}

/**
 * Polls the lag of watched groups (`kafka.lagAlerts`) on connected clusters,
 * shows a status bar warning while any is over its threshold, and notifies
 * once per crossing.
 */
export class LagMonitor implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("kafka-manager.lag", vscode.StatusBarAlignment.Left, 49);
  private readonly subscriptions: vscode.Disposable[];
  private over = new Set<string>();
  private details = new Map<string, { cluster: ClusterConfig; group: string; lag: bigint; threshold: bigint }>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly manager: ClusterManager) {
    this.item.name = "Kafka Lag Alerts";
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`kafka.${ALERTS_KEY}`) || e.affectsConfiguration(`kafka.${INTERVAL_KEY}`)) {
          this.schedule();
          void this.check();
        }
      }),
      manager.onDidChangeStatus((id) => {
        if (manager.getStatus(id) === "connected") {
          void this.check();
        }
      }),
    ];
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (getLagAlerts().length === 0) {
      this.update(new Set());
      return;
    }
    const seconds = Math.max(10, vscode.workspace.getConfiguration("kafka").get<number>(INTERVAL_KEY, 60));
    this.timer = setInterval(() => void this.check(), seconds * 1000);
  }

  /** Measures every watched group on a connected cluster. */
  async check(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const readings: LagReading[] = [];
      const details = new Map<string, { cluster: ClusterConfig; group: string; lag: bigint; threshold: bigint }>();
      const clusters = this.manager.getClusters();
      for (const alert of getLagAlerts()) {
        const cluster = clusters.find((c) => c.id === alert.cluster) ?? clusters.find((c) => c.name === alert.cluster);
        if (!cluster || this.manager.getStatus(cluster.id) !== "connected") {
          continue;
        }
        try {
          const lag = await this.manager.getGroupLag(cluster, alert.group);
          const key = `${cluster.id}\u0000${alert.group}`;
          const threshold = BigInt(Math.max(0, Math.trunc(alert.threshold)));
          readings.push({ key, lag, threshold });
          details.set(key, { cluster, group: alert.group, lag, threshold });
        } catch (error) {
          this.manager.log(`Lag alert: couldn't read lag of "${alert.group}" on "${cluster.name}": ${describeError(error)}`);
        }
      }
      this.details = details;
      const result = evaluateLag(readings, this.over);
      for (const key of result.crossed) {
        const d = details.get(key)!;
        void vscode.window
          .showWarningMessage(
            `Consumer group "${d.group}" on "${d.cluster.name}" is ${d.lag.toLocaleString()} messages behind (threshold ${d.threshold.toLocaleString()}).`,
            "Open Group",
            "Stop Watching",
          )
          .then((choice) => {
            if (choice === "Open Group") {
              vscode.commands.executeCommand("kafka-manager.viewConsumerGroup", { cluster: d.cluster, group: { groupId: d.group } });
            } else if (choice === "Stop Watching") {
              void setLagAlert(d.cluster, d.group, undefined);
            }
          });
      }
      this.update(result.over);
    } finally {
      this.running = false;
    }
  }

  private update(over: Set<string>): void {
    this.over = over;
    if (over.size === 0) {
      this.item.hide();
      return;
    }
    const list = [...over].map((k) => this.details.get(k)).filter((d) => d !== undefined);
    this.item.text = `$(warning) Lag: ${over.size} group${over.size === 1 ? "" : "s"}`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    this.item.tooltip = list.map((d) => `${d.group} (${d.cluster.name}): ${d.lag.toLocaleString()} > ${d.threshold.toLocaleString()}`).join("\n");
    const first = list[0];
    this.item.command = first
      ? { title: "Open Group", command: "kafka-manager.viewConsumerGroup", arguments: [{ cluster: first.cluster, group: { groupId: first.group } }] }
      : undefined;
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
