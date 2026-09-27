import * as crypto from "crypto";
import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig } from "../kafka/types";
import { GroupPanel } from "./groupPanel";
import { TopicPanel } from "./topicPanel";

type WebviewInMessage =
  | { command: "refresh" }
  | { command: "openTopic"; topic: string }
  | { command: "openGroup"; groupId: string };

/**
 * One dashboard per cluster: health tiles, broker layout, topic sizes and
 * consumer-group lag. Reused if already open instead of spawning duplicates.
 */
export class DashboardPanel {
  private static readonly panels = new Map<string, DashboardPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;
  private loading = false;

  static createOrShow(manager: ClusterManager, cluster: ClusterConfig): void {
    const existing = DashboardPanel.panels.get(cluster.id);
    if (existing) {
      existing.panel.reveal();
      existing.load();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "kafkaClusterDashboard",
      `Kafka Dashboard: ${cluster.name}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.panels.set(cluster.id, new DashboardPanel(panel, manager, cluster));
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly manager: ClusterManager,
    private readonly cluster: ClusterConfig
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();

    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewInMessage) => this.handleMessage(message)),
      this.panel.onDidDispose(() => this.dispose()),
      this.manager.onDidChangeStatus((id) => {
        if (id === this.cluster.id) {
          this.postConnection();
          if (this.manager.getStatus(id) === "connected") {
            this.load();
          }
        }
      })
    );

    this.postConnection();
    this.load();
  }

  private handleMessage(message: WebviewInMessage): void {
    switch (message.command) {
      case "refresh":
        this.load();
        break;
      case "openTopic":
        TopicPanel.createOrShow(this.manager, this.cluster, message.topic);
        break;
      case "openGroup":
        GroupPanel.createOrShow(this.manager, this.cluster, message.groupId);
        break;
    }
  }

  private async load(): Promise<void> {
    // Auto-refresh can fire while a slow cluster is still answering; skip rather than pile up.
    if (this.loading) {
      return;
    }
    if (this.manager.getStatus(this.cluster.id) !== "connected") {
      this.post({ command: "status", text: "Not connected. Connect the cluster to load the dashboard.", error: true });
      return;
    }
    this.loading = true;
    this.post({ command: "loading", value: true });
    try {
      const overview = await this.manager.getClusterOverview(this.cluster);
      this.post({ command: "overview", overview });
      this.post({ command: "status", text: `Updated ${new Date().toLocaleTimeString()}` });
    } catch (error) {
      this.manager.log(`Dashboard load failed for "${this.cluster.name}": ${describeError(error)}`);
      this.post({ command: "status", text: `Failed to load dashboard: ${describeError(error)}`, error: true });
    } finally {
      this.loading = false;
      this.post({ command: "loading", value: false });
    }
  }

  private postConnection(): void {
    this.post({ command: "connection", status: this.manager.getStatus(this.cluster.id) });
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      this.panel.webview.postMessage(message);
    }
  }

  private dispose(): void {
    this.disposed = true;
    DashboardPanel.panels.delete(this.cluster.id);
    for (const subscription of this.subscriptions) {
      subscription.dispose();
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
  :root {
    --muted: var(--vscode-descriptionForeground);
    --border: var(--vscode-panel-border);
    --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    --bar: var(--vscode-charts-blue);
    --bar-track: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
    --good: var(--vscode-charts-green);
    --warn: var(--vscode-charts-yellow);
    --crit: var(--vscode-charts-red);
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); padding: 0 16px 24px; margin: 0; }
  header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; justify-content: space-between; padding: 16px 0 12px; border-bottom: 1px solid var(--border); }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
  h2 { font-size: 13px; font-weight: 600; margin: 0; }
  .sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 12px; cursor: pointer; border-radius: 2px; font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.6; cursor: default; }
  select, input[type=search] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--border)); padding: 3px 6px; border-radius: 2px; font: inherit; }
  label.inline { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
  #status { color: var(--muted); font-size: 12px; min-height: 1.2em; margin: 8px 0; }
  #status.error { color: var(--vscode-errorForeground); }

  .chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 500; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; flex: none; }
  .dot.good { background: var(--good); } .dot.warn { background: var(--warn); } .dot.crit { background: var(--crit); }

  .banner { display: flex; gap: 10px; align-items: flex-start; padding: 8px 12px; border-radius: 4px; margin: 12px 0; border-left: 3px solid var(--good); background: var(--card); }
  .banner.warn { border-left-color: var(--warn); } .banner.crit { border-left-color: var(--crit); }
  .banner ul { margin: 2px 0 0; padding-left: 18px; }
  .banner strong { font-weight: 600; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 12px 0 16px; }
  .tile { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; }
  .tile .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 22px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .tile .hint { font-size: 11px; color: var(--muted); margin-top: 2px; display: flex; align-items: center; gap: 4px; min-height: 1.3em; }

  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; margin-bottom: 16px; }
  .grid2 section { margin-bottom: 0; }
  section { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px 12px; margin-bottom: 16px; min-width: 0; }
  .section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
  .section-head .count { color: var(--muted); font-weight: 400; margin-left: 4px; }
  .scroll { overflow-x: auto; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; user-select: none; }
  th.sortable { cursor: pointer; }
  th.sortable:hover { color: var(--vscode-foreground); }
  th .arrow { opacity: 0.8; font-size: 10px; margin-left: 2px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.name { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
  tr.link { cursor: pointer; }
  tr.link:hover td { background: var(--vscode-list-hoverBackground); }
  tr.link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .barcell { width: 30%; min-width: 90px; }
  .bar { height: 6px; border-radius: 3px; background: var(--bar-track); overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--bar); border-radius: 3px; min-width: 2px; }
  .bar.zero > span { display: none; }
  .empty { color: var(--muted); font-size: 12px; padding: 8px 0; }
  .health { display: inline-flex; align-items: center; gap: 4px; }
  .loading-overlay { opacity: 0.55; transition: opacity 0.15s; }
</style>
</head>
<body>
  <header>
    <div>
      <h1><span>${escapeHtml(this.cluster.name)}</span><span class="chip" id="connChip"><span class="dot"></span><span>…</span></span></h1>
      <div class="sub">${escapeHtml(this.cluster.brokers.join(", "))}<span id="clusterId"></span></div>
    </div>
    <div class="toolbar">
      <label class="inline">Auto-refresh
        <select id="autoRefresh" aria-label="Auto-refresh interval">
          <option value="0">Off</option>
          <option value="10">10s</option>
          <option value="30">30s</option>
          <option value="60">60s</option>
        </select>
      </label>
      <button id="refreshBtn">Refresh</button>
    </div>
  </header>
  <div id="status" role="status"></div>

  <main id="content" hidden>
    <div id="banner" class="banner" role="note"></div>
    <div class="tiles" id="tiles"></div>

    <div class="grid2">
      <section aria-labelledby="brokersTitle">
        <div class="section-head"><h2 id="brokersTitle">Brokers<span class="count" id="brokersCount"></span></h2></div>
        <div class="scroll" id="brokersBody"></div>
      </section>
      <section aria-labelledby="groupsTitle">
        <div class="section-head">
          <h2 id="groupsTitle">Consumer Groups<span class="count" id="groupsCount"></span></h2>
          <input type="search" id="groupFilter" placeholder="Filter groups" aria-label="Filter consumer groups" />
        </div>
        <div class="scroll" id="groupsBody"></div>
      </section>
    </div>

    <section aria-labelledby="topicsTitle">
      <div class="section-head">
        <h2 id="topicsTitle">Topics<span class="count" id="topicsCount"></span></h2>
        <div class="toolbar">
          <label class="inline"><input type="checkbox" id="unhealthyOnly" /> Unhealthy only</label>
          <input type="search" id="topicFilter" placeholder="Filter topics" aria-label="Filter topics" />
        </div>
      </div>
      <div class="scroll" id="topicsBody"></div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const saved = vscode.getState() || {};
    const state = {
      overview: null,
      topicSort: saved.topicSort || { key: 'name', dir: 1 },
      groupSort: saved.groupSort || { key: 'totalLag', dir: -1 },
      autoRefresh: saved.autoRefresh || 0,
    };
    let timer = null;

    function persist() {
      vscode.setState({ topicSort: state.topicSort, groupSort: state.groupSort, autoRefresh: state.autoRefresh });
    }

    function esc(text) {
      const div = document.createElement('div');
      div.textContent = text == null ? '' : String(text);
      return div.innerHTML;
    }

    const fmt = new Intl.NumberFormat();
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    // Counts arrive as decimal strings (they can exceed 2^53); BigInt keeps sorting and formatting exact.
    const big = (s) => { try { return BigInt(s); } catch { return 0n; } };
    const fmtBig = (s) => fmt.format(big(s));
    const cmpBig = (a, b) => { const x = big(a), y = big(b); return x < y ? -1 : x > y ? 1 : 0; };
    const ratio = (value, max) => (max > 0n ? Number((big(value) * 1000n) / max) / 10 : 0);

    function bar(value, max, label) {
      const pct = ratio(value, max);
      return '<div class="bar' + (big(value) === 0n ? ' zero' : '') + '" title="' + esc(label) + '"><span style="width:' + pct + '%"></span></div>';
    }

    function statusBadge(level, text) {
      return '<span class="health"><span class="dot ' + level + '"></span>' + esc(text) + '</span>';
    }

    // ---- Header / tiles / banner ----------------------------------------

    const CONN = {
      connected: ['good', 'Connected'],
      connecting: ['warn', 'Connecting…'],
      error: ['crit', 'Error'],
      disconnected: ['', 'Disconnected'],
    };

    function renderConnection(status) {
      const [level, text] = CONN[status] || CONN.disconnected;
      $('connChip').innerHTML = '<span class="dot ' + level + '"></span><span>' + esc(text) + '</span>';
      $('refreshBtn').disabled = status !== 'connected';
    }

    function tile(label, value, hint, level) {
      return '<div class="tile"><div class="label">' + esc(label) + '</div>' +
        '<div class="value">' + value + '</div>' +
        '<div class="hint">' + (level ? '<span class="dot ' + level + '"></span>' : '') + esc(hint || '') + '</div></div>';
    }

    function renderTiles(o) {
      const t = o.totals;
      const lag = big(t.totalLag);
      const controller = o.controllerId == null ? 'no controller' : 'controller #' + o.controllerId;
      $('tiles').innerHTML = [
        tile('Brokers', fmt.format(t.brokers), controller, o.controllerId == null ? 'crit' : ''),
        tile('Topics', fmt.format(t.topics), 'excluding internal'),
        tile('Partitions', fmt.format(t.partitions), t.topics ? 'avg ' + (t.partitions / t.topics).toFixed(1) + ' / topic' : ''),
        tile('Under-replicated', fmt.format(t.underReplicated), t.underReplicated ? 'ISR < replicas' : 'Healthy', t.underReplicated ? 'warn' : 'good'),
        tile('Offline', fmt.format(t.offline), t.offline ? 'No leader' : 'Healthy', t.offline ? 'crit' : 'good'),
        tile('Consumer groups', fmt.format(t.groups), o.groups.filter((g) => g.state === 'Stable').length + ' stable'),
        tile('Total lag', '<span title="' + esc(fmtBig(t.totalLag)) + ' messages">' + compact.format(lag) + '</span>', 'messages behind', lag > 0n ? 'warn' : 'good'),
      ].join('');
    }

    function renderBanner(o) {
      const issues = [];
      let level = 'good';
      if (o.controllerId == null) { issues.push('No active controller.'); level = 'crit'; }
      if (o.totals.offline) {
        const names = o.topics.filter((t) => t.offline).map((t) => t.name);
        issues.push(o.totals.offline + ' offline partition(s) in ' + names.slice(0, 5).join(', ') + (names.length > 5 ? '…' : ''));
        level = 'crit';
      }
      if (o.totals.underReplicated) {
        const names = o.topics.filter((t) => t.underReplicated).map((t) => t.name);
        issues.push(o.totals.underReplicated + ' under-replicated partition(s) in ' + names.slice(0, 5).join(', ') + (names.length > 5 ? '…' : ''));
        if (level === 'good') level = 'warn';
      }
      const empty = o.groups.filter((g) => g.state === 'Empty' && big(g.totalLag) > 0n).length;
      if (empty) {
        issues.push(empty + ' consumer group(s) have lag but no active members.');
        if (level === 'good') level = 'warn';
      }
      const banner = $('banner');
      banner.className = 'banner ' + level;
      banner.innerHTML = issues.length
        ? '<span class="dot ' + level + '" style="margin-top:4px"></span><div><strong>' + (level === 'crit' ? 'Cluster needs attention' : 'Warnings') + '</strong><ul>' + issues.map((i) => '<li>' + esc(i) + '</li>').join('') + '</ul></div>'
        : '<span class="dot good" style="margin-top:4px"></span><div><strong>Cluster healthy.</strong> All partitions have a leader and a full ISR.</div>';
    }

    // ---- Tables -----------------------------------------------------------

    function header(cols, sort, table) {
      return '<thead><tr>' + cols.map((c) => {
        const cls = [c.num ? 'num' : '', c.key ? 'sortable' : ''].join(' ').trim();
        const arrow = c.key && sort && sort.key === c.key ? '<span class="arrow">' + (sort.dir > 0 ? '▲' : '▼') + '</span>' : '';
        const aria = c.key && sort && sort.key === c.key ? ' aria-sort="' + (sort.dir > 0 ? 'ascending' : 'descending') + '"' : '';
        return '<th class="' + cls + '"' + aria + (c.key ? ' data-table="' + table + '" data-key="' + c.key + '"' : '') + '>' + esc(c.label) + arrow + '</th>';
      }).join('') + '</tr></thead>';
    }

    function renderBrokers(o) {
      $('brokersCount').textContent = '(' + o.brokers.length + ')';
      if (!o.brokers.length) { $('brokersBody').innerHTML = '<div class="empty">No brokers reported.</div>'; return; }
      const maxLeaders = BigInt(Math.max(0, ...o.brokers.map((b) => b.leaderCount)));
      const cols = [{ label: 'ID' }, { label: 'Host' }, { label: 'Role' }, { label: 'Leaders', num: true }, { label: 'Leader share' }, { label: 'Replicas', num: true }];
      const rows = o.brokers.map((b) => '<tr>' +
        '<td>' + b.nodeId + '</td>' +
        '<td>' + esc(b.host + ':' + b.port) + '</td>' +
        '<td>' + (b.isController ? '<span class="chip">Controller</span>' : '<span class="sub">Broker</span>') + '</td>' +
        '<td class="num">' + fmt.format(b.leaderCount) + '</td>' +
        '<td class="barcell">' + bar(String(b.leaderCount), maxLeaders, b.leaderCount + ' of ' + o.totals.partitions + ' partition leaders') + '</td>' +
        '<td class="num">' + fmt.format(b.replicaCount) + '</td>' +
        '</tr>').join('');
      $('brokersBody').innerHTML = '<table>' + header(cols) + '<tbody>' + rows + '</tbody></table>';
    }

    const GROUP_STATE = { Stable: 'good', Empty: '', PreparingRebalance: 'warn', CompletingRebalance: 'warn', Dead: 'crit' };

    function sortRows(rows, sort, bigKeys) {
      const { key, dir } = sort;
      return rows.slice().sort((a, b) => {
        const r = bigKeys.includes(key) ? cmpBig(a[key], b[key])
          : typeof a[key] === 'number' ? a[key] - b[key]
          : String(a[key]).localeCompare(String(b[key]));
        return r * dir || String(a.name || a.groupId).localeCompare(String(b.name || b.groupId));
      });
    }

    function renderGroups(o) {
      const q = $('groupFilter').value.trim().toLowerCase();
      const list = sortRows(o.groups.filter((g) => !q || g.groupId.toLowerCase().includes(q)), state.groupSort, ['totalLag']);
      $('groupsCount').textContent = '(' + (q ? list.length + ' of ' : '') + o.groups.length + ')';
      if (!list.length) { $('groupsBody').innerHTML = '<div class="empty">' + (o.groups.length ? 'No groups match the filter.' : 'No consumer groups.') + '</div>'; return; }
      const maxLag = o.groups.reduce((m, g) => (big(g.totalLag) > m ? big(g.totalLag) : m), 0n);
      const cols = [
        { label: 'Group', key: 'groupId' }, { label: 'State', key: 'state' }, { label: 'Members', key: 'memberCount', num: true },
        { label: 'Lag', key: 'totalLag', num: true }, { label: '' },
      ];
      const rows = list.map((g) => '<tr class="link" tabindex="0" data-group="' + esc(g.groupId) + '" title="Open group details">' +
        '<td class="name">' + esc(g.groupId) + '<div class="sub">' + esc(g.topics.join(', ') || 'no committed offsets') + '</div></td>' +
        '<td>' + statusBadge(GROUP_STATE[g.state] ?? 'warn', g.state) + '</td>' +
        '<td class="num">' + fmt.format(g.memberCount) + '</td>' +
        '<td class="num">' + fmtBig(g.totalLag) + '</td>' +
        '<td class="barcell">' + bar(g.totalLag, maxLag, fmtBig(g.totalLag) + ' messages behind') + '</td>' +
        '</tr>').join('');
      $('groupsBody').innerHTML = '<table>' + header(cols, state.groupSort, 'group') + '<tbody>' + rows + '</tbody></table>';
    }

    function topicHealth(t) {
      if (t.offline) return ['crit', t.offline + ' offline'];
      if (t.underReplicated) return ['warn', t.underReplicated + ' under-replicated'];
      return ['good', 'Healthy'];
    }

    function renderTopics(o) {
      const q = $('topicFilter').value.trim().toLowerCase();
      const unhealthy = $('unhealthyOnly').checked;
      const withHealth = o.topics.map((t) => ({ ...t, issues: t.offline * 1000000 + t.underReplicated }));
      const list = sortRows(withHealth.filter((t) => (!q || t.name.toLowerCase().includes(q)) && (!unhealthy || t.issues > 0)), state.topicSort, ['messageCount']);
      $('topicsCount').textContent = '(' + (q || unhealthy ? list.length + ' of ' : '') + o.topics.length + ')';
      if (!list.length) { $('topicsBody').innerHTML = '<div class="empty">' + (o.topics.length ? 'No topics match the filter.' : 'No topics.') + '</div>'; return; }
      const maxMsgs = o.topics.reduce((m, t) => (big(t.messageCount) > m ? big(t.messageCount) : m), 0n);
      const cols = [
        { label: 'Topic', key: 'name' }, { label: 'Partitions', key: 'partitionCount', num: true },
        { label: 'RF', key: 'replicationFactor', num: true }, { label: 'Health', key: 'issues' },
        { label: 'Messages', key: 'messageCount', num: true }, { label: '' },
      ];
      const rows = list.map((t) => {
        const [level, text] = topicHealth(t);
        return '<tr class="link" tabindex="0" data-topic="' + esc(t.name) + '" title="Browse messages">' +
          '<td class="name">' + esc(t.name) + '</td>' +
          '<td class="num">' + fmt.format(t.partitionCount) + '</td>' +
          '<td class="num">' + t.replicationFactor + '</td>' +
          '<td>' + statusBadge(level, text) + '</td>' +
          '<td class="num">' + fmtBig(t.messageCount) + '</td>' +
          '<td class="barcell">' + bar(t.messageCount, maxMsgs, fmtBig(t.messageCount) + ' messages retained') + '</td>' +
          '</tr>';
      }).join('');
      $('topicsBody').innerHTML = '<table>' + header(cols, state.topicSort, 'topic') + '<tbody>' + rows + '</tbody></table>';
    }

    function renderAll() {
      const o = state.overview;
      if (!o) return;
      $('content').hidden = false;
      $('clusterId').textContent = o.clusterId ? ' · cluster ' + o.clusterId : '';
      renderTiles(o);
      renderBanner(o);
      renderBrokers(o);
      renderGroups(o);
      renderTopics(o);
    }

    // ---- Interaction ------------------------------------------------------

    function setAutoRefresh(seconds) {
      state.autoRefresh = seconds;
      persist();
      if (timer) clearInterval(timer);
      timer = seconds > 0 ? setInterval(() => vscode.postMessage({ command: 'refresh' }), seconds * 1000) : null;
    }

    document.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-key]');
      if (th) {
        const sortKey = th.dataset.table === 'topic' ? 'topicSort' : 'groupSort';
        const cur = state[sortKey];
        const numeric = th.classList.contains('num') || th.dataset.key === 'issues';
        state[sortKey] = cur.key === th.dataset.key ? { key: cur.key, dir: -cur.dir } : { key: th.dataset.key, dir: numeric ? -1 : 1 };
        persist();
        renderAll();
        return;
      }
      openRow(e.target.closest('tr.link'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches && e.target.matches('tr.link')) openRow(e.target);
    });
    function openRow(tr) {
      if (!tr) return;
      if (tr.dataset.topic != null) vscode.postMessage({ command: 'openTopic', topic: tr.dataset.topic });
      else if (tr.dataset.group != null) vscode.postMessage({ command: 'openGroup', groupId: tr.dataset.group });
    }

    $('refreshBtn').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    $('autoRefresh').addEventListener('change', (e) => setAutoRefresh(Number(e.target.value)));
    $('topicFilter').addEventListener('input', () => state.overview && renderTopics(state.overview));
    $('unhealthyOnly').addEventListener('change', () => state.overview && renderTopics(state.overview));
    $('groupFilter').addEventListener('input', () => state.overview && renderGroups(state.overview));

    $('autoRefresh').value = String(state.autoRefresh);
    setAutoRefresh(state.autoRefresh);

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'connection':
          renderConnection(message.status);
          break;
        case 'loading':
          $('content').classList.toggle('loading-overlay', message.value);
          break;
        case 'status':
          $('status').textContent = message.text;
          $('status').classList.toggle('error', !!message.error);
          break;
        case 'overview':
          state.overview = message.overview;
          renderAll();
          break;
      }
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
