import * as crypto from "crypto";
import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig } from "../kafka/types";

interface WebviewInMessage {
  command: "refresh";
}

/**
 * One webview panel per (cluster, group). Reused if already open instead of
 * spawning duplicates.
 */
export class GroupPanel {
  private static readonly panels = new Map<string, GroupPanel>();

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  static createOrShow(manager: ClusterManager, cluster: ClusterConfig, groupId: string): void {
    const key = `${cluster.id}:${groupId}`;
    const existing = GroupPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      existing.load();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "kafkaGroupDetails",
      `Kafka Group: ${groupId}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const instance = new GroupPanel(panel, manager, cluster, groupId, key);
    GroupPanel.panels.set(key, instance);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly manager: ClusterManager,
    private readonly cluster: ClusterConfig,
    private readonly groupId: string,
    private readonly key: string
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();

    this.panel.webview.onDidReceiveMessage((message: WebviewInMessage) => this.handleMessage(message));
    this.panel.onDidDispose(() => this.dispose());

    this.load();
  }

  private async handleMessage(message: WebviewInMessage): Promise<void> {
    if (message.command === "refresh") {
      await this.load();
    }
  }

  private async load(): Promise<void> {
    this.post({ command: "status", text: "Loading group details..." });
    try {
      const [details, offsets] = await Promise.all([
        this.manager.getGroupDetails(this.cluster, this.groupId),
        this.manager.fetchGroupOffsets(this.cluster, this.groupId),
      ]);
      this.post({ command: "details", details });
      this.post({ command: "offsets", offsets });
      this.post({ command: "status", text: `Updated ${new Date().toLocaleTimeString()}.` });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load group: ${describeError(error)}` });
    }
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      this.panel.webview.postMessage(message);
    }
  }

  private dispose(): void {
    this.disposed = true;
    GroupPanel.panels.delete(this.key);
  }

  private render(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px 12px; }
  h2 { font-weight: 600; margin: 14px 0 4px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  #status { color: var(--vscode-descriptionForeground); font-size: 12px; min-height: 1.2em; margin-bottom: 6px; }
  .meta { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12px; margin-bottom: 4px; }
  .meta span.label { color: var(--vscode-descriptionForeground); margin-right: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 4px 0; }
</style>
</head>
<body>
  <div class="toolbar">
    <h2 style="margin:12px 0 0">${escapeHtml(this.groupId)}</h2>
  </div>
  <div class="toolbar">
    <button id="refreshBtn">Refresh</button>
  </div>
  <div id="status"></div>

  <div class="meta" id="meta"></div>

  <h2>Members</h2>
  <div id="membersEmpty" class="empty" style="display:none">No active members.</div>
  <table id="membersTable">
    <thead><tr><th>Member ID</th><th>Client ID</th><th>Client Host</th><th>Assigned Partitions</th></tr></thead>
    <tbody id="membersRows"></tbody>
  </table>

  <h2>Committed Offsets</h2>
  <div id="offsetsEmpty" class="empty" style="display:none">No committed offsets.</div>
  <table id="offsetsTable">
    <thead><tr><th>Topic</th><th>Partition</th><th>Offset</th><th>High Watermark</th><th>Lag</th></tr></thead>
    <tbody id="offsetsRows"></tbody>
  </table>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const status = document.getElementById('status');
    const meta = document.getElementById('meta');
    const membersRows = document.getElementById('membersRows');
    const membersEmpty = document.getElementById('membersEmpty');
    const offsetsRows = document.getElementById('offsetsRows');
    const offsetsEmpty = document.getElementById('offsetsEmpty');

    function esc(text) {
      const div = document.createElement('div');
      div.textContent = text ?? '';
      return div.innerHTML;
    }

    function renderDetails(details) {
      meta.innerHTML =
        '<span><span class="label">State:</span>' + esc(details.state) + '</span>' +
        '<span><span class="label">Protocol:</span>' + esc(details.protocol || 'n/a') + '</span>' +
        '<span><span class="label">Protocol Type:</span>' + esc(details.protocolType || 'n/a') + '</span>';

      membersRows.innerHTML = '';
      membersEmpty.style.display = details.members.length === 0 ? 'block' : 'none';
      for (const member of details.members) {
        const assignment = member.assignment
          .map((a) => a.topic + ': [' + a.partitions.join(', ') + ']')
          .join(', ') || 'n/a';
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(member.memberId) + '</td>' +
          '<td>' + esc(member.clientId) + '</td>' +
          '<td>' + esc(member.clientHost) + '</td>' +
          '<td>' + esc(assignment) + '</td>';
        membersRows.appendChild(tr);
      }
    }

    function renderOffsets(offsets) {
      offsetsRows.innerHTML = '';
      offsetsEmpty.style.display = offsets.length === 0 ? 'block' : 'none';
      for (const entry of offsets) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(entry.topic) + '</td>' +
          '<td>' + esc(entry.partition) + '</td>' +
          '<td>' + esc(entry.offset) + '</td>' +
          '<td>' + esc(entry.high) + '</td>' +
          '<td>' + esc(entry.lag) + '</td>';
        offsetsRows.appendChild(tr);
      }
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'status':
          status.textContent = message.text;
          break;
        case 'details':
          renderDetails(message.details);
          break;
        case 'offsets':
          renderOffsets(message.offsets);
          break;
      }
    });

    document.getElementById('refreshBtn').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  </script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
