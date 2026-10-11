import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig } from "../kafka/types";
import {
  disconnectedBannerCss,
  disconnectedBannerHtml,
  disconnectedBannerScript,
  watchCluster,
} from "./clusterWatch";
import { baseCss, contentSecurityPolicy, createNonce, icons, scriptValue, sharedScript } from "./webview";

type WebviewInMessage = { command: "ready" } | { command: "refresh" } | { command: "connect" };

/** Read-only, filterable list of every ACL on a cluster. */
export class AclPanel {
  private static readonly panels = new Map<string, AclPanel>();

  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  static createOrShow(manager: ClusterManager, cluster: ClusterConfig): void {
    const existing = AclPanel.panels.get(cluster.id);
    if (existing) {
      existing.panel.reveal();
      void existing.load();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "kafkaAcls",
      `ACLs: ${cluster.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    AclPanel.panels.set(cluster.id, new AclPanel(panel, manager, cluster));
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly manager: ClusterManager,
    private cluster: ClusterConfig,
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
          panel.title = `ACLs: ${updated.name}`;
          this.postConnection();
        },
      }),
    );
  }

  private async handleMessage(message: WebviewInMessage): Promise<void> {
    switch (message.command) {
      case "ready":
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
      const acls = await this.manager.listAcls(this.cluster);
      this.post({ command: "acls", acls, at: new Date().toLocaleTimeString() });
    } catch (error) {
      this.post({ command: "failed", text: describeError(error) });
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
    AclPanel.panels.delete(this.cluster.id);
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
  .allow { color: var(--good); } .deny { color: var(--crit); font-weight: 600; }
</style>
</head>
<body>
  ${disconnectedBannerHtml()}
  <main>
    <header class="page">
      <div>
        <div class="title"><h1>ACLs</h1></div>
        <div class="sub" id="meta"></div>
      </div>
      <div class="toolbar">
        <label><span class="sr-only">Filter by principal</span><input type="search" id="principal" placeholder="Principal, e.g. User:alice" /></label>
        <label><span class="sr-only">Filter by resource</span><input type="search" id="resource" placeholder="Resource name" /></label>
        <select id="type" aria-label="Resource type"><option value="">All types</option><option>TOPIC</option><option>GROUP</option><option>CLUSTER</option><option>TRANSACTIONAL_ID</option><option>DELEGATION_TOKEN</option></select>
        <button class="secondary" id="refreshBtn" data-needs-connection>${icons.refresh}Refresh</button>
      </div>
    </header>
    <div class="progress" id="progress"></div>
    <div id="failure" class="alert warn" role="alert" hidden>${icons.warning}<div class="body" id="failureText"></div></div>
    <section class="card" id="listCard" hidden>
      <div class="scroll" id="body"></div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${sharedScript}
${disconnectedBannerScript}
    const state = { acls: null, at: '', clusterName: ${scriptValue(this.cluster.name)} };

    function render() {
      $('meta').textContent = state.clusterName + (state.at ? ' · updated ' + state.at : '');
      if (!state.acls) return;
      const p = $('principal').value.trim().toLowerCase();
      const r = $('resource').value.trim().toLowerCase();
      const t = $('type').value;
      const list = state.acls.filter((a) => (!p || a.principal.toLowerCase().includes(p)) && (!r || a.resourceName.toLowerCase().includes(r)) && (!t || a.resourceType === t));
      $('listCard').hidden = false;
      $('body').innerHTML = list.length
        ? '<table><thead><tr><th>Principal</th><th>Permission</th><th>Operation</th><th>Resource</th><th>Name</th><th>Pattern</th><th>Host</th></tr></thead><tbody>' +
          list.map((a) => '<tr><td class="mono">' + esc(a.principal) + '</td><td class="' + (a.permission === 'DENY' ? 'deny' : 'allow') + '">' + esc(a.permission) + '</td><td>' +
            esc(a.operation) + '</td><td>' + esc(a.resourceType) + '</td><td class="mono name">' + esc(a.resourceName) + '</td><td class="muted">' + esc(a.patternType) +
            '</td><td class="mono">' + esc(a.host) + '</td></tr>').join('') + '</tbody></table>'
        : '<div class="empty">' + (state.acls.length ? 'No ACLs match the filters.' : 'This cluster has no ACLs.') + '</div>';
    }

    for (const id of ['principal', 'resource']) $(id).addEventListener('input', render);
    $('type').addEventListener('change', render);
    $('refreshBtn').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    window.addEventListener('message', (event) => {
      const m = event.data;
      switch (m.command) {
        case 'connection': state.clusterName = m.clusterName; renderConnection(m.status, m.clusterName); render(); break;
        case 'acls': state.acls = m.acls; state.at = m.at; $('failure').hidden = true; render(); break;
        case 'failed': $('failure').hidden = false; $('failureText').textContent = m.text; break;
        case 'loading': $('progress').classList.toggle('active', m.value); $('refreshBtn').disabled = m.value; break;
      }
    });
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
