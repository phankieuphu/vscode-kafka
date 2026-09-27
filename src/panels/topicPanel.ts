import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig } from "../kafka/types";
import { baseCss, contentSecurityPolicy, createNonce, escapeHtml, icons, scriptValue, sharedScript } from "./webview";

type WebviewInMessage =
  | { command: "ready" }
  | { command: "refreshDetails" }
  | { command: "loadRecent"; limit: number }
  | { command: "startTail" }
  | { command: "stopTail" }
  | { command: "loadConfig" }
  | { command: "copy"; text: string }
  | {
      command: "produce";
      key: string;
      value: string;
      partition: number | null;
      headers: Record<string, string>;
    };

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
      `Kafka Topic: ${topic}`,
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
      case "ready":
      case "refreshDetails":
        await this.loadDetails();
        break;
      case "loadRecent":
        await this.loadRecent(message.limit);
        break;
      case "startTail":
        await this.startTail();
        break;
      case "stopTail":
        await this.stopTail();
        break;
      case "loadConfig":
        await this.loadConfig();
        break;
      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        this.post({ command: "status", text: "Copied to clipboard." });
        break;
      case "produce":
        await this.produce(message);
        break;
    }
  }

  private async loadDetails(): Promise<void> {
    try {
      const details = await this.manager.getTopicDetails(this.cluster, this.topic);
      this.post({ command: "details", details });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load topic: ${describeError(error)}`, error: true });
    }
    await this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    try {
      const entries = await this.manager.getTopicConfig(this.cluster, this.topic);
      this.post({ command: "config", entries });
    } catch (error) {
      this.post({ command: "config", entries: null, error: describeError(error) });
    }
  }

  private async produce(message: Extract<WebviewInMessage, { command: "produce" }>): Promise<void> {
    try {
      await this.manager.produce(this.cluster, this.topic, {
        key: message.key,
        value: message.value,
        partition: message.partition ?? undefined,
        headers: message.headers,
      });
      this.post({ command: "produced", ok: true });
      this.post({ command: "status", text: `Sent message to "${this.topic}" at ${new Date().toLocaleTimeString()}.` });
    } catch (error) {
      this.post({ command: "produced", ok: false });
      this.post({ command: "status", text: `Failed to send: ${describeError(error)}`, error: true });
    }
  }

  private async startTail(): Promise<void> {
    if (this.tailHandle) {
      return;
    }
    try {
      this.tailHandle = await this.manager.startTail(
        this.cluster,
        this.topic,
        (msg) => this.post({ command: "messages", items: [msg], mode: "prepend" }),
        (error) => {
          this.tailHandle = undefined;
          this.post({ command: "tailState", running: false });
          this.post({ command: "status", text: `Tail error: ${describeError(error)}`, error: true });
        }
      );
      this.post({ command: "tailState", running: true, since: new Date().toLocaleTimeString() });
    } catch (error) {
      this.post({ command: "tailState", running: false });
      this.post({ command: "status", text: `Failed to start tail: ${describeError(error)}`, error: true });
    }
  }

  private async stopTail(): Promise<void> {
    const handle = this.tailHandle;
    this.tailHandle = undefined;
    if (handle) {
      await handle.stop();
    }
    this.post({ command: "tailState", running: false });
  }

  private async loadRecent(limit: number): Promise<void> {
    this.post({ command: "loading", value: true });
    try {
      const messages = await this.manager.loadRecentMessages(this.cluster, this.topic, limit);
      messages.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
      this.post({ command: "messages", items: messages, mode: "replace" });
      this.post({ command: "status", text: `Loaded ${messages.length} message(s) at ${new Date().toLocaleTimeString()}.` });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load recent messages: ${describeError(error)}`, error: true });
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
    TopicPanel.panels.delete(this.key);
    if (this.tailHandle) {
      this.tailHandle.stop().catch(() => undefined);
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
  body { padding: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  header.page { padding: 14px 20px 12px; margin: 0; }
  .view { flex-grow: 1; min-height: 0; overflow: auto; }
  #messagesView { display: flex; overflow: hidden; }
  .list { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
  .list > .toolbar { padding: 10px 20px; border-bottom: 1px solid var(--border); }
  .list .statusline { padding: 6px 20px; display: flex; justify-content: space-between; gap: 8px; }
  .rows { flex-grow: 1; overflow: auto; }
  .rows table { table-layout: fixed; }
  .rows th { position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
  .rows td { overflow: hidden; text-overflow: ellipsis; }
  .rows th:first-child, .rows td:first-child { padding-left: 20px; }
  td.key { color: var(--vscode-debugTokenExpression-name, var(--vscode-textLink-foreground)); }
  aside { width: 440px; flex-shrink: 0; overflow: auto; display: flex; flex-direction: column; }
  aside section { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  aside section + section { border-top: 1px solid var(--border); }
  .kv { display: grid; grid-template-columns: 70px minmax(0, 1fr); row-gap: 4px; font-size: 12px; }
  .kv > :nth-child(odd) { color: var(--muted); }
  .kv > :nth-child(even) { overflow-wrap: anywhere; }
  pre.value { margin: 0; padding: 10px 12px; background: var(--vscode-textCodeBlock-background, var(--card)); border: 1px solid var(--border); border-radius: 4px;
    font-family: var(--mono); font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow: auto; }
  .j-key { color: var(--vscode-debugTokenExpression-name, #9cdcfe); }
  .j-str { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .j-num { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .j-lit { color: var(--vscode-debugTokenExpression-boolean, #569cd6); }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) 130px; gap: 8px; }
  .header-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 26px; gap: 6px; }
  .validity { font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
  .validity.ok { color: var(--good); } .validity.bad { color: var(--vscode-errorForeground); }
  .pad { padding: 14px 20px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--crit); }
  @media (max-width: 900px) { #messagesView { flex-direction: column; overflow: auto; } aside { width: auto; } .list { border-right: none; min-height: 420px; } }
</style>
</head>
<body>
  <header class="page">
    <div>
      <div class="title"><h1>${escapeHtml(this.topic)}</h1><span class="sub">${escapeHtml(this.cluster.name)}</span></div>
      <div class="meta" id="meta"><span class="sk" style="width:260px;height:10px"></span></div>
    </div>
    <div class="seg" role="tablist" aria-label="View">
      <button role="tab" aria-selected="true" data-tab="messagesView">Messages</button>
      <button role="tab" aria-selected="false" data-tab="partitionsView">Partitions</button>
      <button role="tab" aria-selected="false" data-tab="configView">Configuration</button>
    </div>
  </header>
  <div class="progress" id="progress"></div>

  <div class="view" id="messagesView" role="tabpanel">
    <section class="list" aria-label="Messages">
      <div class="toolbar">
        <div class="seg" aria-label="Mode">
          <button aria-pressed="true" id="modeLatest">Latest</button>
          <button aria-pressed="false" id="modeLive"><span class="live-dot" id="liveDot" hidden></span>Live tail</button>
        </div>
        <span id="latestControls" class="toolbar">
          <label class="inline" for="limit">Per partition</label>
          <select id="limit"><option>20</option><option selected>50</option><option>100</option><option>500</option></select>
          <button id="loadBtn">Load</button>
        </span>
        <button class="secondary" id="pauseBtn" hidden>${icons.pause}Pause</button>
        <label class="inline" for="partitionFilter">Partition</label>
        <select id="partitionFilter"><option value="">All</option></select>
        <label style="display:flex;flex-grow:1;min-width:160px"><span class="sr-only">Search key or value</span><input type="search" id="search" placeholder="Search key or value" style="flex-grow:1" /></label>
        <button class="secondary" id="clearBtn">Clear</button>
      </div>
      <div class="statusline sub"><span id="status" role="status">Choose Load to read the newest messages, or switch to Live tail.</span><span id="countNote"></span></div>
      <div class="rows">
        <table>
          <colgroup><col style="width:64px" /><col style="width:104px" /><col style="width:96px" /><col style="width:150px" /><col /></colgroup>
          <thead><tr><th>Part.</th><th class="num">Offset</th><th>Time</th><th>Key</th><th>Value</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="empty" id="rowsEmpty">No messages loaded yet.</div>
      </div>
    </section>

    <aside>
      <section aria-labelledby="detailTitle">
        <div class="section-head" style="margin:0">
          <h2 id="detailTitle">Message</h2>
          <div class="toolbar" id="detailActions" hidden>
            <button class="icon" id="copyBtn" aria-label="Copy value" title="Copy value">${icons.copy}</button>
            <button class="icon" id="resendBtn" aria-label="Load into produce form" title="Load into produce form">${icons.resend}</button>
          </div>
        </div>
        <div id="detail" class="sub">Select a message to inspect its key, headers and value.</div>
      </section>

      <section aria-labelledby="produceTitle">
        <h2 id="produceTitle">Produce message</h2>
        <div class="two">
          <label class="field">Key (optional)<input type="text" class="mono" id="pKey" /></label>
          <label class="field">Partition<select id="pPartition"><option value="">Auto (by key)</option></select></label>
        </div>
        <label class="field">Value<textarea id="pValue" rows="6" placeholder='{ "id": 1 }'></textarea></label>
        <div id="headers" class="stack" style="gap:6px"></div>
        <div class="toolbar" style="justify-content:space-between">
          <span class="validity" id="validity"></span>
          <span class="toolbar">
            <button class="secondary" id="addHeader">+ Header</button>
            <button id="sendBtn" title="Send (Ctrl/Cmd+Enter)">Send</button>
          </span>
        </div>
      </section>
    </aside>
  </div>

  <div class="view pad" id="partitionsView" role="tabpanel" hidden>
    <div class="card"><div class="scroll" id="partitionsBody"><div class="empty">Loading partitions…</div></div></div>
  </div>

  <div class="view pad" id="configView" role="tabpanel" hidden>
    <div class="card">
      <div class="section-head">
        <h2>Configuration<span class="count" id="configCount"></span></h2>
        <div class="toolbar">
          <label class="inline"><input type="checkbox" id="showDefaults" /> Show defaults</label>
          <label><span class="sr-only">Filter configuration</span><input type="search" id="configFilter" placeholder="Filter settings" /></label>
        </div>
      </div>
      <div class="scroll" id="configBody"><div class="empty">Loading configuration…</div></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${sharedScript}
    const MAX_ROWS = 500;
    const state = { details: null, config: null, messages: [], selected: null, live: false, tailing: false, since: '', received: 0, tailStart: 0 };

    function fmtTime(ts) {
      const d = new Date(Number(ts));
      return isNaN(d) ? '' : d.toLocaleTimeString();
    }
    function fmtDateTime(ts) {
      const d = new Date(Number(ts));
      return isNaN(d) ? '' : d.toLocaleString() + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }
    function oneLine(text) { return text == null ? 'null' : String(text).replace(/\\s+/g, ' '); }

    function highlightJson(text) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { return null; }
      if (parsed === null || typeof parsed !== 'object') return null;
      const pretty = esc(JSON.stringify(parsed, null, 2));
      return pretty.replace(/(&quot;(?:[^&\\\\]|\\\\.|&(?!quot;))*?&quot;)(\\s*:)?|\\b(true|false|null)\\b|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)/g,
        (m, str, colon, lit, num) => str ? '<span class="' + (colon ? 'j-key' : 'j-str') + '">' + str + '</span>' + (colon || '')
          : lit ? '<span class="j-lit">' + lit + '</span>'
          : '<span class="j-num">' + num + '</span>');
    }

    // ---- Header, partitions, config -----------------------------------------

    function topicHealth(d) {
      if (d.offline) return ['crit', d.offline + ' offline'];
      if (d.underReplicated) return ['warn', d.underReplicated + ' under-replicated'];
      return ['good', 'Healthy'];
    }

    function renderMeta() {
      const d = state.details;
      if (!d) return;
      const [level, text] = topicHealth(d);
      const cfg = state.config || [];
      const pick = (name) => (cfg.find((e) => e.name === name) || {}).value;
      const retention = pick('retention.ms');
      const retentionText = retention == null ? '' : retention === '-1' ? 'retention ∞' : 'retention ' + humanMs(Number(retention));
      const policy = pick('cleanup.policy');
      $('meta').innerHTML = [
        d.partitions.length + ' partition' + (d.partitions.length === 1 ? '' : 's'),
        'RF ' + d.replicationFactor,
        fmtBig(d.messageCount) + ' messages',
        badge(level, text),
        policy ? esc('cleanup.policy=' + policy + (retentionText ? ' · ' + retentionText : '')) : '',
      ].filter(Boolean).map((x) => x.startsWith('<') ? x : '<span>' + x + '</span>').join('');
    }

    function humanMs(ms) {
      const units = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
      for (const [u, n] of units) if (ms >= n && ms % n === 0) return ms / n + u;
      return ms + 'ms';
    }

    function renderPartitionOptions() {
      const d = state.details;
      const opts = d.partitions.map((p) => '<option value="' + p.partitionId + '">' + p.partitionId + '</option>').join('');
      const current = $('partitionFilter').value;
      $('partitionFilter').innerHTML = '<option value="">All (' + d.partitions.length + ')</option>' + opts;
      $('partitionFilter').value = current;
      const pCurrent = $('pPartition').value;
      $('pPartition').innerHTML = '<option value="">Auto (by key)</option>' + opts;
      $('pPartition').value = pCurrent;
    }

    function renderPartitions() {
      const d = state.details;
      const max = maxBig(d.partitions.map((p) => p.messageCount));
      const rows = d.partitions.map((p) => {
        const level = p.leader < 0 ? ['crit', 'Offline'] : p.isr.length < p.replicas.length ? ['warn', 'Under-replicated'] : ['good', 'In sync'];
        return '<tr' + (p.leader < 0 ? ' class="row-crit"' : '') + '>' +
          '<td>' + p.partitionId + '</td>' +
          '<td>' + (p.leader < 0 ? '<span class="muted">none</span>' : p.leader) + '</td>' +
          '<td>' + esc(p.replicas.join(', ')) + '</td>' +
          '<td>' + esc(p.isr.join(', ') || '—') + '</td>' +
          '<td>' + badge(level[0], level[1]) + '</td>' +
          '<td class="num">' + fmtBig(p.low) + '</td>' +
          '<td class="num">' + fmtBig(p.high) + '</td>' +
          '<td class="num">' + fmtBig(p.messageCount) + '</td>' +
          '<td class="barcell">' + bar(p.messageCount, max, fmtBig(p.messageCount) + ' messages') + '</td></tr>';
      }).join('');
      $('partitionsBody').innerHTML = '<table><thead><tr><th>Partition</th><th>Leader</th><th>Replicas</th><th>ISR</th><th>Health</th>' +
        '<th class="num">Earliest</th><th class="num">Latest</th><th class="num">Messages</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function renderConfig(error) {
      if (!state.config) {
        $('configBody').innerHTML = '<div class="empty">' + esc(error ? 'Could not load configuration: ' + error : 'Loading configuration…') + '</div>';
        return;
      }
      const q = $('configFilter').value.trim().toLowerCase();
      const all = $('showDefaults').checked;
      const list = state.config.filter((e) => (all || !e.isDefault) && (!q || e.name.includes(q) || String(e.value).toLowerCase().includes(q)));
      const overrides = state.config.filter((e) => !e.isDefault).length;
      $('configCount').textContent = overrides + ' overridden · ' + state.config.length + ' total';
      if (!list.length) {
        $('configBody').innerHTML = '<div class="empty">' + (all || q ? 'No settings match.' : 'Every setting uses the broker default. Tick “Show defaults” to see them.') + '</div>';
        return;
      }
      $('configBody').innerHTML = '<table><thead><tr><th>Setting</th><th>Value</th><th>Source</th></tr></thead><tbody>' +
        list.map((e) => '<tr><td class="mono">' + esc(e.name) + '</td><td class="mono">' + esc(e.value) + '</td><td>' +
          (e.isDefault ? '<span class="muted">default</span>' : '<span class="chip">override</span>') + (e.readOnly ? ' <span class="muted">read-only</span>' : '') +
          '</td></tr>').join('') + '</tbody></table>';
    }

    // ---- Messages -------------------------------------------------------------

    function visibleMessages() {
      const partition = $('partitionFilter').value;
      const q = $('search').value.trim().toLowerCase();
      return state.messages.filter((m) =>
        (partition === '' || String(m.partition) === partition) &&
        (!q || String(m.key ?? '').toLowerCase().includes(q) || String(m.value ?? '').toLowerCase().includes(q)));
    }

    function msgId(m) { return m.partition + ':' + m.offset; }

    function renderRows() {
      const list = visibleMessages();
      $('rows').innerHTML = list.map((m) => '<tr class="link' + (state.selected === msgId(m) ? ' selected' : '') + '" tabindex="0" data-id="' + esc(msgId(m)) + '">' +
        '<td>' + m.partition + '</td>' +
        '<td class="num">' + fmtBig(m.offset) + '</td>' +
        '<td class="muted" title="' + esc(fmtDateTime(m.timestamp)) + '">' + esc(fmtTime(m.timestamp)) + '</td>' +
        '<td class="mono key">' + esc(m.key == null ? 'null' : m.key) + '</td>' +
        '<td class="mono">' + esc(oneLine(m.value)) + '</td></tr>').join('');
      const empty = $('rowsEmpty');
      empty.hidden = list.length > 0;
      empty.innerHTML = state.messages.length
        ? 'No messages match the filters. <button class="small secondary" id="clearFilters">Clear filters</button>'
        : state.live ? 'Waiting for new messages…' : 'No messages loaded yet.';
      $('countNote').textContent = state.messages.length
        ? (list.length !== state.messages.length ? list.length + ' of ' : '') + state.messages.length + ' shown · newest first · max ' + MAX_ROWS
        : '';
    }

    function renderDetail() {
      const m = state.messages.find((x) => msgId(x) === state.selected);
      $('detailActions').hidden = !m;
      if (!m) {
        $('detailTitle').textContent = 'Message';
        $('detail').className = 'sub';
        $('detail').textContent = 'Select a message to inspect its key, headers and value.';
        return;
      }
      $('detailTitle').textContent = 'Message · partition ' + m.partition + ' · offset ' + fmtBig(m.offset);
      const headers = Object.entries(m.headers || {});
      const pretty = m.value == null ? null : highlightJson(m.value);
      $('detail').className = 'stack';
      $('detail').style.gap = '10px';
      $('detail').innerHTML = '<div class="kv">' +
        '<span>Key</span><span class="mono key" style="color:var(--vscode-debugTokenExpression-name)">' + esc(m.key == null ? 'null' : m.key) + '</span>' +
        '<span>Time</span><span>' + esc(fmtDateTime(m.timestamp)) + '</span>' +
        '<span>Headers</span><span class="mono">' + (headers.length ? headers.map(([k, v]) => esc(k + '=' + v)).join(' · ') : '<span class="muted">none</span>') + '</span>' +
        '<span>Size</span><span>' + fmt.format(new TextEncoder().encode(m.value || '').length) + ' bytes</span></div>' +
        '<pre class="value">' + (pretty ?? (m.value == null ? '<span class="muted">null</span>' : esc(m.value))) + '</pre>';
    }

    function updateStatusLine() {
      if (!state.tailing) return;
      const secs = Math.max(1, (Date.now() - state.tailStart) / 1000);
      $('status').textContent = 'Tailing since ' + state.since + ' · ' + fmt.format(state.received) + ' received · ~' + (state.received / secs).toFixed(1) + ' msg/s';
      $('status').classList.remove('error');
    }

    function setMode(live) {
      state.live = live;
      $('modeLatest').setAttribute('aria-pressed', String(!live));
      $('modeLive').setAttribute('aria-pressed', String(live));
      $('latestControls').hidden = live;
      $('pauseBtn').hidden = !live;
      if (live) {
        vscode.postMessage({ command: 'startTail' });
      } else {
        vscode.postMessage({ command: 'stopTail' });
      }
      renderRows();
    }

    function setTailing(running, since) {
      state.tailing = running;
      $('liveDot').hidden = !running;
      $('pauseBtn').innerHTML = running ? ${scriptValue(icons.pause + "Pause")} : ${scriptValue(icons.play + "Resume")};
      if (running) {
        state.since = since;
        state.received = 0;
        state.tailStart = Date.now();
        updateStatusLine();
      } else if (state.live) {
        $('status').textContent = 'Paused. ' + fmt.format(state.received) + ' received.';
      }
    }

    // ---- Produce --------------------------------------------------------------

    function addHeaderRow(name, value) {
      const row = document.createElement('div');
      row.className = 'header-row';
      row.innerHTML = '<label><span class="sr-only">Header name</span><input type="text" class="mono h-name" placeholder="name" style="width:100%" /></label>' +
        '<label><span class="sr-only">Header value</span><input type="text" class="mono h-value" placeholder="value" style="width:100%" /></label>' +
        '<button class="icon" aria-label="Remove header" title="Remove header">' + ${scriptValue(icons.close)} + '</button>';
      row.querySelector('.h-name').value = name || '';
      row.querySelector('.h-value').value = value || '';
      row.querySelector('button').addEventListener('click', () => row.remove());
      $('headers').appendChild(row);
    }

    function readHeaders() {
      const headers = {};
      for (const row of $('headers').children) {
        const name = row.querySelector('.h-name').value.trim();
        if (name) headers[name] = row.querySelector('.h-value').value;
      }
      return headers;
    }

    function updateValidity() {
      const text = $('pValue').value.trim();
      const el = $('validity');
      if (!text) { el.className = 'validity'; el.textContent = ''; return; }
      const looksJson = text.startsWith('{') || text.startsWith('[');
      if (!looksJson) { el.className = 'validity muted'; el.textContent = 'Plain text'; return; }
      try {
        JSON.parse(text);
        el.className = 'validity ok';
        el.innerHTML = ${scriptValue(icons.tick)} + 'Valid JSON';
      } catch (e) {
        el.className = 'validity bad';
        el.textContent = 'Invalid JSON — ' + e.message;
      }
    }

    function send() {
      const value = $('pValue').value;
      if (!value) {
        $('status').textContent = 'Message value is required.';
        $('status').classList.add('error');
        $('pValue').focus();
        return;
      }
      $('sendBtn').disabled = true;
      const partition = $('pPartition').value;
      vscode.postMessage({ command: 'produce', key: $('pKey').value, value, partition: partition === '' ? null : Number(partition), headers: readHeaders() });
    }

    // ---- Wiring -----------------------------------------------------------------

    document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      document.querySelectorAll('[role=tabpanel]').forEach((p) => { p.hidden = p.id !== tab.dataset.tab; });
      if (tab.dataset.tab === 'configView' && !state.config) vscode.postMessage({ command: 'loadConfig' });
    }));

    $('modeLatest').addEventListener('click', () => state.live && setMode(false));
    $('modeLive').addEventListener('click', () => !state.live && setMode(true));
    $('pauseBtn').addEventListener('click', () => vscode.postMessage({ command: state.tailing ? 'stopTail' : 'startTail' }));
    $('loadBtn').addEventListener('click', () => vscode.postMessage({ command: 'loadRecent', limit: Number($('limit').value) }));
    $('clearBtn').addEventListener('click', () => { state.messages = []; state.selected = null; renderRows(); renderDetail(); });
    $('partitionFilter').addEventListener('change', renderRows);
    $('search').addEventListener('input', renderRows);
    $('configFilter').addEventListener('input', () => renderConfig());
    $('showDefaults').addEventListener('change', () => renderConfig());
    $('pValue').addEventListener('input', updateValidity);
    $('addHeader').addEventListener('click', () => addHeaderRow());
    $('sendBtn').addEventListener('click', send);
    $('pValue').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    $('copyBtn').addEventListener('click', () => {
      const m = state.messages.find((x) => msgId(x) === state.selected);
      if (m) vscode.postMessage({ command: 'copy', text: m.value ?? '' });
    });
    $('resendBtn').addEventListener('click', () => {
      const m = state.messages.find((x) => msgId(x) === state.selected);
      if (!m) return;
      $('pKey').value = m.key ?? '';
      $('pValue').value = m.value ?? '';
      $('headers').innerHTML = '';
      for (const [k, v] of Object.entries(m.headers || {})) addHeaderRow(k, v);
      updateValidity();
      $('pValue').focus();
    });

    function select(tr) {
      if (!tr) return;
      state.selected = tr.dataset.id;
      renderRows();
      renderDetail();
    }
    $('rows').addEventListener('click', (e) => select(e.target.closest('tr')));
    $('rows').addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling;
        if (next) { select(next); document.querySelector('tr[data-id="' + CSS.escape(next.dataset.id) + '"]').focus(); }
      }
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('#clearFilters')) { $('partitionFilter').value = ''; $('search').value = ''; renderRows(); }
    });

    setInterval(updateStatusLine, 1000);

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'details':
          state.details = message.details;
          renderMeta();
          renderPartitionOptions();
          renderPartitions();
          break;
        case 'config':
          state.config = message.entries;
          renderMeta();
          renderConfig(message.error);
          break;
        case 'messages':
          if (message.mode === 'replace') {
            state.messages = message.items;
          } else {
            state.messages = message.items.concat(state.messages);
            state.received += message.items.length;
          }
          if (state.messages.length > MAX_ROWS) state.messages.length = MAX_ROWS;
          renderRows();
          if (message.mode === 'replace') renderDetail();
          break;
        case 'tailState':
          setTailing(message.running, message.since);
          break;
        case 'loading':
          $('progress').classList.toggle('active', message.value);
          $('loadBtn').disabled = message.value;
          break;
        case 'produced':
          $('sendBtn').disabled = false;
          if (message.ok) { $('pValue').value = ''; updateValidity(); vscode.postMessage({ command: 'refreshDetails' }); }
          break;
        case 'status':
          $('status').textContent = message.text;
          $('status').classList.toggle('error', !!message.error);
          break;
      }
    });

    renderRows();
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }
}
