import * as vscode from "vscode";
import { ClusterManager, describeError } from "./kafka/clusterManager";
import { analyzeLag, LagHistory, LagSample, toSample } from "./kafka/lagTrend";
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

export function historyKey(clusterId: string, group: string): string {
  return `${clusterId}\u0000${group}`;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
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
/** Optional AI hooks, so the monitor works (and is tested) without them. */
export interface LagAiHooks {
  /** AI is enabled, trusted and a provider is set up: show "Analyze". */
  available(): Promise<boolean>;
  /** A one-line cause from the model, for `kafka.ai.autoAnalyzeLagAlerts`; undefined to skip. */
  summarize?(cluster: ClusterConfig, group: string, samples: LagSample[], threshold: bigint): Promise<string | undefined>;
}

export const ANALYZE = "Analyze";

export class LagMonitor implements vscode.Disposable {
  /** The last readings of each watched group, in memory only. */
  readonly history = new LagHistory();
  private readonly item = vscode.window.createStatusBarItem("kafka-manager.lag", vscode.StatusBarAlignment.Left, 49);
  private readonly subscriptions: vscode.Disposable[];
  private over = new Set<string>();
  private details = new Map<string, { cluster: ClusterConfig; group: string; lag: bigint; threshold: bigint }>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly manager: ClusterManager,
    private readonly ai?: LagAiHooks,
  ) {
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
      void this.update(new Set());
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
          // Same broker calls as getGroupLag; the per-partition detail feeds the trend.
          const entries = await this.manager.fetchGroupOffsets(cluster, alert.group);
          const sample = toSample(entries);
          const lag = sample.total;
          const key = historyKey(cluster.id, alert.group);
          this.history.push(key, sample);
          const threshold = BigInt(Math.max(0, Math.trunc(alert.threshold)));
          readings.push({ key, lag, threshold });
          details.set(key, { cluster, group: alert.group, lag, threshold });
        } catch (error) {
          this.manager.log(`Lag alert: couldn't read lag of "${alert.group}" on "${cluster.name}": ${describeError(error)}`);
        }
      }
      this.details = details;
      this.history.retain(new Set(readings.map((r) => r.key)));
      const result = evaluateLag(readings, this.over);
      for (const key of result.crossed) {
        void this.notify(details.get(key)!);
      }
      await this.update(result.over);
    } finally {
      this.running = false;
    }
  }

  /** One notification per crossing, with Kafka Manager's own guess at the cause and, if AI is set up, Analyze. */
  private async notify(d: { cluster: ClusterConfig; group: string; lag: bigint; threshold: bigint }): Promise<void> {
    const samples = this.history.get(historyKey(d.cluster.id, d.group));
    const finding = analyzeLag(samples).findings[0];
    const aiReady = (await this.ai?.available().catch(() => false)) ?? false;
    let summary: string | undefined;
    if (aiReady && this.ai?.summarize && vscode.workspace.getConfiguration("kafka.ai").get<boolean>("autoAnalyzeLagAlerts", false)) {
      summary = await this.ai.summarize(d.cluster, d.group, samples, d.threshold).catch(() => undefined);
    }
    const why = summary ? ` AI: ${summary}` : finding ? ` ${finding.text}` : "";
    const actions = aiReady ? [ANALYZE, "Open Group", "Stop Watching"] : ["Open Group", "Stop Watching"];
    const choice = await vscode.window.showWarningMessage(
      `Consumer group "${d.group}" on "${d.cluster.name}" is ${d.lag.toLocaleString()} messages behind (threshold ${d.threshold.toLocaleString()}).${why}`,
      ...actions,
    );
    if (choice === ANALYZE) {
      void vscode.commands.executeCommand("kafka-manager.analyzeLag", { cluster: d.cluster, group: { groupId: d.group } });
    } else if (choice === "Open Group") {
      void vscode.commands.executeCommand("kafka-manager.viewConsumerGroup", { cluster: d.cluster, group: { groupId: d.group } });
    } else if (choice === "Stop Watching") {
      void setLagAlert(d.cluster, d.group, undefined);
    }
  }

  /** Readings of one watched group, oldest first. */
  getHistory(clusterId: string, group: string): LagSample[] {
    return this.history.get(historyKey(clusterId, group));
  }

  private async update(over: Set<string>): Promise<void> {
    this.over = over;
    if (over.size === 0) {
      this.item.hide();
      return;
    }
    const list = [...over].map((k) => this.details.get(k)).filter((d) => d !== undefined);
    this.item.text = `$(warning) Lag: ${over.size} group${over.size === 1 ? "" : "s"}`;
    this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    const aiReady = (await this.ai?.available().catch(() => false)) ?? false;
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = { enabledCommands: ["kafka-manager.viewConsumerGroup", "kafka-manager.analyzeLag"] };
    for (const d of list) {
      const args = encodeURIComponent(JSON.stringify([{ cluster: d.cluster, group: { groupId: d.group } }]));
      tooltip.appendMarkdown(
        `**${escapeMd(d.group)}** (${escapeMd(d.cluster.name)}): ${d.lag.toLocaleString()} > ${d.threshold.toLocaleString()} — ` +
          `[Open](command:kafka-manager.viewConsumerGroup?${args})` +
          (aiReady ? ` · [$(sparkle) Analyze](command:kafka-manager.analyzeLag?${args})` : "") +
          "\n\n",
      );
    }
    this.item.tooltip = tooltip;
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
