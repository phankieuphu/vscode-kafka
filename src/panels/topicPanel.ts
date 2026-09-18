import * as crypto from "crypto";
import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig, ConsumedMessage } from "../kafka/types";

interface WebviewInMessage {
  command: "produce" | "toggleTail" | "loadRecent" | "clear";
  key?: string;
  value?: string;
  limit?: number;
}

/**
 * One webview panel per (cluster, topic). Reused if already open instead of
 * spawning duplicates.
 */
export class TopicPanel {
  private static readonly panels = new Map<string, TopicPanel>();

  private readonly panel: vscode.WebviewPanel;
  private tailHandle: { stop: () => Promise<void> } | undefined;
  private disposed = false;

  static createOrShow(
    manager: ClusterManager,
    cluster: ClusterConfig,
    topic: string
  ): void {
    const key = `${cluster.id}:${topic}`;
    const existing = TopicPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "kafkaTopicBrowser",
      `Kafka: ${topic}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    const instance = new TopicPanel(panel, manager, cluster, topic, key);
    TopicPanel.panels.set(key, instance);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly manager: ClusterManager,
    private readonly cluster: ClusterConfig,
    private readonly topic: string,
    private readonly key: string
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();

    this.panel.webview.onDidReceiveMessage((message: WebviewInMessage) =>
      this.handleMessage(message)
    );
    this.panel.onDidDispose(() => this.dispose());
  }

  private async handleMessage(message: WebviewInMessage): Promise<void> {
    switch (message.command) {
      case "produce":
        await this.produce(message.key ?? "", message.value ?? "");
        break;
      case "toggleTail":
        await this.toggleTail();
        break;
      case "loadRecent":
        await this.loadRecent(message.limit ?? 50);
        break;
      case "clear":
        this.post({ command: "clear" });
        break;
    }
  }

  private async produce(key: string, value: string): Promise<void> {
    if (!value) {
      this.post({ command: "status", text: "Message value is required." });
      return;
    }
    try {
      await this.manager.produce(this.cluster, this.topic, key || undefined, value);
      this.post({ command: "status", text: `Sent message to "${this.topic}".` });
    } catch (error) {
      this.post({ command: "status", text: `Failed to send: ${describeError(error)}` });
    }
  }

  private async toggleTail(): Promise<void> {
    if (this.tailHandle) {
      await this.tailHandle.stop();
      this.tailHandle = undefined;
      this.post({ command: "tailState", running: false });
      this.post({ command: "status", text: "Tail stopped." });
      return;
    }

    try {
      this.tailHandle = await this.manager.startTail(
        this.cluster,
        this.topic,
        (msg) => this.post({ command: "messages", items: [msg] }),
        (error) => {
          this.post({ command: "status", text: `Tail error: ${describeError(error)}` });
          this.tailHandle = undefined;
          this.post({ command: "tailState", running: false });
        }
      );
      this.post({ command: "tailState", running: true });
      this.post({ command: "status", text: "Tailing new messages..." });
    } catch (error) {
      this.post({ command: "status", text: `Failed to start tail: ${describeError(error)}` });
    }
  }

  private async loadRecent(limit: number): Promise<void> {
    this.post({ command: "status", text: `Loading up to ${limit} recent message(s) per partition...` });
    try {
      const messages = await this.manager.loadRecentMessages(this.cluster, this.topic, limit);
      this.post({ command: "messages", items: messages.reverse() });
      this.post({ command: "status", text: `Loaded ${messages.length} message(s).` });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load recent messages: ${describeError(error)}` });
    }
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      this.panel.webview.postMessage(message);
    }
  }

  private dispose(): void {
    this.disposed = true;
    TopicPanel.panels.delete(this.key);
    if (this.tailHandle) {
      this.tailHandle.stop().catch(() => undefined);
    }
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
  h2 { font-weight: 600; margin: 12px 0 4px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  input, textarea { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px; border-radius: 2px; font-family: var(--vscode-editor-font-family); }
  #status { color: var(--vscode-descriptionForeground); font-size: 12px; min-height: 1.2em; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.value { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); }
  .produce { border-top: 1px solid var(--vscode-panel-border); margin-top: 14px; padding-top: 10px; }
  .produce-row { display: flex; gap: 8px; align-items: flex-start; }
  .produce-row input { width: 160px; }
  .produce-row textarea { flex: 1; min-height: 32px; }
  #limit { width: 55px; }
</style>
</head>
<body>
  <h2>${escapeHtml(this.topic)}</h2>
  <div class="toolbar">
    <button id="tailBtn">Start Tail</button>
    <button id="loadBtn">Load Recent</button>
    <input id="limit" type="number" value="50" min="1" max="1000" title="Messages per partition" />
    <button id="clearBtn">Clear</button>
  </div>
  <div id="status"></div>
  <table>
    <thead><tr><th>Partition</th><th>Offset</th><th>Timestamp</th><th>Key</th><th>Value</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>

  <div class="produce">
    <h2>Produce Message</h2>
    <div class="produce-row">
      <input id="key" type="text" placeholder="Key (optional)" />
      <textarea id="value" placeholder="Value"></textarea>
      <button id="sendBtn">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const rows = document.getElementById('rows');
    const status = document.getElementById('status');
    const tailBtn = document.getElementById('tailBtn');
    let tailing = false;

    function esc(text) {
      const div = document.createElement('div');
      div.textContent = text ?? '';
      return div.innerHTML;
    }

    function prependRow(msg) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + esc(msg.partition) + '</td>' +
        '<td>' + esc(msg.offset) + '</td>' +
        '<td>' + esc(new Date(Number(msg.timestamp)).toLocaleString()) + '</td>' +
        '<td>' + esc(msg.key) + '</td>' +
        '<td class="value">' + esc(msg.value) + '</td>';
      rows.insertBefore(tr, rows.firstChild);
    }

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'messages':
          for (const item of message.items) {
            prependRow(item);
          }
          break;
        case 'status':
          status.textContent = message.text;
          break;
        case 'tailState':
          tailing = message.running;
          tailBtn.textContent = tailing ? 'Stop Tail' : 'Start Tail';
          break;
        case 'clear':
          rows.innerHTML = '';
          break;
      }
    });

    tailBtn.addEventListener('click', () => vscode.postMessage({ command: 'toggleTail' }));
    document.getElementById('loadBtn').addEventListener('click', () => {
      const limit = Number(document.getElementById('limit').value) || 50;
      vscode.postMessage({ command: 'loadRecent', limit });
    });
    document.getElementById('clearBtn').addEventListener('click', () => vscode.postMessage({ command: 'clear' }));
    document.getElementById('sendBtn').addEventListener('click', () => {
      const key = document.getElementById('key').value;
      const value = document.getElementById('value').value;
      vscode.postMessage({ command: 'produce', key, value });
      document.getElementById('value').value = '';
    });
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
