import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig } from "../kafka/types";
import {
  disconnectedBannerCss,
  disconnectedBannerHtml,
  disconnectedBannerScript,
  watchCluster,
} from "./clusterWatch";
import { baseCss, contentSecurityPolicy, createNonce, icons, scriptValue, sharedScript, sparkleIcon } from "./webview";
import { isAiReady, onDidChangeAiAvailability } from "../ai/model";
import { openAssistant } from "../ai/open";

type WebviewInMessage = { command: "ready" } | { command: "refresh" } | { command: "connect" } | { command: "explainAi" };

/** Read-only view of one broker: role, partition load and its effective settings. */
export class BrokerPanel {
  private static readonly panels = new Map<string, BrokerPanel>();

  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  static createOrShow(manager: ClusterManager, cluster: ClusterConfig, nodeId: number): void {
    const key = `${cluster.id}:${nodeId}`;
    const existing = BrokerPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      void existing.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "kafkaBroker",
      `Broker ${nodeId}: ${cluster.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    BrokerPanel.panels.set(key, new BrokerPanel(panel, manager, cluster, nodeId, key));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly manager: ClusterManager,
    private cluster: ClusterConfig,
    private readonly nodeId: number,
    private readonly key: string,
  ) {
    panel.webview.html = this.render();
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((message: WebviewInMessage) => this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose()),
      watchCluster(manager, cluster.id, {
        onStatus: (status) => {
          this.postConnection();
          if (status === "connected") {
            void this.load();
          }
        },
        onRemoved: () => panel.dispose(),
        onChanged: (updated) => {
          this.cluster = updated;
          panel.title = `Broker ${nodeId}: ${updated.name}`;
          this.postConnection();
        },
      }),
      onDidChangeAiAvailability(() => void this.postAi()),
    );
  }

  private async postAi(): Promise<void> {
    this.post({ command: "ai", available: await isAiReady() });
  }

  private async handleMessage(message: WebviewInMessage): Promise<void> {
    switch (message.command) {
      case "explainAi":
        openAssistant(this.manager, this.cluster.id, {
          task: "broker-config",
          prompt: "",
          label: `Explain broker ${this.nodeId}'s settings`,
          target: { brokerId: this.nodeId },
        });
        break;
      case "ready":
        void this.postAi();
        this.postConnection();
        await this.load();
        break;
      case "refresh":
        await this.load();
        break;
      case "connect":
        await this.manager.connect(this.cluster).catch(() => undefined);
        break;
    }
  }

  private postConnection(): void {
    this.post({ command: "connection", status: this.manager.getStatus(this.cluster.id), clusterName: this.cluster.name });
  }

  private async load(): Promise<void> {
    if (this.manager.getStatus(this.cluster.id) !== "connected") {
      return;
    }
    this.post({ command: "loading", value: true });
    try {
      const broker = await this.manager.getBrokerDetails(this.cluster, this.nodeId);
      this.post({ command: "broker", broker, at: new Date().toLocaleTimeString() });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load broker ${this.nodeId}: ${describeError(error)}`, error: true });
    } finally {
      this.post({ command: "loading", value: false });
    }
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      this.panel.webview.postMessage(message);
    }
  }

  private dispose(): void {
    this.disposed = true;
    BrokerPanel.panels.delete(this.key);
    for (const s of this.subscriptions) {
      s.dispose();
    }
  }

  private render(): string {
    const nonce = createNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}" />
<style>
${baseCss}
${disconnectedBannerCss}
  body { padding: 0; }
  main { padding: 0 20px 24px; }
</style>
</head>
<body>
  ${disconnectedBannerHtml()}
  <main>
    <header class="page">
      <div>
        <div class="title"><h1>Broker ${this.nodeId}</h1><span class="chip" id="role">…</span></div>
        <div class="sub" id="meta"></div>
      </div>
      <div class="toolbar" data-needs-connection>
        <button class="secondary" id="explainAiBtn" hidden title="Explain notable settings and risky ones with AI">${sparkleIcon}Explain config</button>
        <button class="secondary" id="refreshBtn">${icons.refresh}Refresh</button>
      </div>
    </header>
    <div class="progress" id="progress"></div>
    <div id="status" role="status" style="margin-bottom:10px"></div>
    <div class="stack">
      <div class="tiles" id="tiles"></div>
      <section class="card" aria-labelledby="configTitle">
        <div class="section-head">
          <h2 id="configTitle">Settings<span class="count" id="configCount"></span></h2>
          <div class="toolbar">
            <label class="inline"><input type="checkbox" id="showDefaults" /> Show defaults</label>
            <label><span class="sr-only">Filter settings</span><input type="search" id="filter" placeholder="Filter settings" /></label>
          </div>
        </div>
        <div class="scroll" id="configBody"><div class="empty">Loading…</div></div>
      </section>
      <div class="sub">Log directory sizes aren't shown: KafkaJS has no DescribeLogDirs API. Use <span class="mono">kafka-log-dirs.sh --describe</span> for them.</div>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${sharedScript}
${disconnectedBannerScript}
    const state = { broker: null, at: '', clusterName: ${scriptValue(this.cluster.name)} };
    const tile = (label, value, hint) => '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div><div class="hint">' + esc(hint || '') + '</div></div>';

    function render() {
      const b = state.broker;
      if (!b) return;
      $('role').innerHTML = b.isController ? dot('good') + 'Controller' : dot('idle') + 'Broker';
      $('meta').textContent = [state.clusterName, b.host + ':' + b.port, b.rack ? 'rack ' + b.rack : '', 'updated ' + state.at].filter(Boolean).join(' · ');
      $('tiles').innerHTML = [
        tile('Leader partitions', fmt.format(b.leaderCount), 'partitions this broker leads'),
        tile('Replicas', fmt.format(b.replicaCount), 'leader or follower'),
        tile('Settings', fmt.format(b.config.length), b.config.filter((c) => !c.isDefault).length + ' not default'),
      ].join('');
      const q = $('filter').value.trim().toLowerCase();
      const all = $('showDefaults').checked;
      const list = b.config.filter((c) => (all || !c.isDefault) && (!q || c.name.includes(q) || String(c.value ?? '').toLowerCase().includes(q)));
      $('configCount').textContent = list.length + ' of ' + b.config.length;
      $('configBody').innerHTML = list.length
        ? '<table><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>' +
          list.map((c) => '<tr><td class="mono">' + esc(c.name) + '</td><td class="mono">' + (c.isSensitive ? '<span class="muted">hidden</span>' : esc(c.value ?? '')) + '</td><td>' +
            esc(c.source) + (c.readOnly ? ' <span class="muted">read-only</span>' : '') + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="empty">No settings match.</div>';
    }

    $('refreshBtn').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    $('explainAiBtn').addEventListener('click', () => vscode.postMessage({ command: 'explainAi' }));
    $('filter').addEventListener('input', render);
    $('showDefaults').addEventListener('change', render);
    window.addEventListener('message', (event) => {
      const m = event.data;
      switch (m.command) {
        case 'connection': state.clusterName = m.clusterName; renderConnection(m.status, m.clusterName); render(); break;
        case 'broker': state.broker = m.broker; state.at = m.at; $('status').textContent = ''; render(); break;
        case 'ai': $('explainAiBtn').hidden = !m.available; break;
        case 'loading': $('progress').classList.toggle('active', m.value); $('refreshBtn').disabled = m.value; break;
        case 'status': $('status').textContent = m.text; $('status').classList.toggle('error', !!m.error); break;
      }
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
