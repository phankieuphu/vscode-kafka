import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { listIssues } from "../kafka/dashboard";
import { ClusterConfig } from "../kafka/types";
import { GroupPanel } from "./groupPanel";
import { TopicPanel } from "./topicPanel";
import { baseCss, contentSecurityPolicy, createNonce, escapeHtml, icons, scriptValue, sharedScript } from "./webview";

type WebviewInMessage =
  | { command: "refresh" }
  | { command: "connect" }
  | { command: "showOutput" }
  | { command: "openTopic"; topic: string }
  | { command: "openGroup"; groupId: string };

export interface HealthReport {
  clusterId: string;
  issues: number;
}

const healthEmitter = new vscode.EventEmitter<HealthReport>();
export const onDidReportHealth = healthEmitter.event;

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
      `Dashboard: ${cluster.name}`,
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

  private async handleMessage(message: WebviewInMessage): Promise<void> {
    switch (message.command) {
      case "refresh":
        await this.load();
        break;
      case "connect":
        try {
          await this.manager.connect(this.cluster);
        } catch {
          this.postConnection();
        }
        break;
      case "showOutput":
        this.manager.showOutput();
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
    if (this.loading || this.manager.getStatus(this.cluster.id) !== "connected") {
      return;
    }
    this.loading = true;
    this.post({ command: "loading", value: true });
    try {
      const overview = await this.manager.getClusterOverview(this.cluster);
      const issues = listIssues(overview);
      this.post({ command: "overview", overview, issues, at: new Date().toLocaleTimeString() });
      healthEmitter.fire({ clusterId: this.cluster.id, issues: issues.length });
    } catch (error) {
      this.manager.log(`Dashboard load failed for "${this.cluster.name}": ${describeError(error)}`);
      this.post({ command: "failed", text: describeError(error) });
    } finally {
      this.loading = false;
      this.post({ command: "loading", value: false });
    }
  }

  private postConnection(): void {
    this.post({
      command: "connection",
      status: this.manager.getStatus(this.cluster.id),
      error: this.manager.getLastError(this.cluster.id) ?? null,
    });
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
    const nonce = createNonce();
    const name = escapeHtml(this.cluster.name);
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}" />
<style>
${baseCss}
  .skeleton-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; }
  .skeleton-tile { height: 70px; border-radius: 4px; background: var(--card); border: 1px solid var(--border); padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .skeleton-rows { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
  .skeleton-rows div { display: flex; gap: 16px; }
</style>
</head>
<body>
  <header class="page">
    <div>
      <div class="title"><h1>${name}</h1><span class="chip" id="connChip"><span class="dot"></span><span>…</span></span></div>
      <div class="sub">${escapeHtml(this.cluster.brokers.join(", "))}<span id="clusterMeta"></span></div>
    </div>
    <div class="toolbar" id="actions">
      <label class="inline" for="autoRefresh">Auto-refresh</label>
      <select id="autoRefresh">
        <option value="0">Off</option>
        <option value="10">10s</option>
        <option value="30">30s</option>
        <option value="60">60s</option>
      </select>
      <button id="refreshBtn">${icons.refresh}Refresh</button>
    </div>
  </header>
  <div class="progress" id="progress" role="progressbar" aria-label="Loading"></div>

  <section id="disconnected" class="empty-state" hidden>
    ${icons.plug}
    <div class="title" id="discTitle"></div>
    <p id="discText"></p>
    <div class="toolbar">
      <button id="connectBtn">Connect</button>
      <button class="secondary" id="discOutputBtn">Show Output</button>
    </div>
  </section>

  <section id="skeleton" class="stack" aria-busy="true" hidden>
    <div class="skeleton-tiles">
      ${Array.from({ length: 7 }, () => '<div class="skeleton-tile"><div class="sk" style="width:60%;height:8px"></div><div class="sk" style="width:40%;height:16px"></div></div>').join("")}
    </div>
    <div class="card skeleton-rows">
      ${Array.from({ length: 6 }, () => '<div><span class="sk" style="width:30%;height:10px"></span><span class="sk" style="width:10%;height:10px"></span><span class="sk" style="flex-grow:1;height:10px"></span></div>').join("")}
    </div>
    <div id="status" role="status">Loading cluster overview…</div>
  </section>

  <div id="failure" class="alert error" role="alert" hidden style="margin-bottom:14px">
    ${icons.error}
    <div class="body">
      <strong>Couldn’t refresh ${name}</strong>
      <span class="mono" id="failureText"></span>
    </div>
    <div class="toolbar">
      <button class="small" id="retryBtn">Retry</button>
      <button class="small secondary" id="failOutputBtn">Show Output</button>
    </div>
  </div>

  <main id="content" class="stack" hidden>
    <div id="banner" class="banner" role="note"></div>
    <div class="tiles" id="tiles"></div>

    <div class="grid2">
      <section class="card" aria-labelledby="brokersTitle">
        <div class="section-head"><h2 id="brokersTitle">Brokers<span class="count" id="brokersCount"></span></h2></div>
        <div class="scroll" id="brokersBody"></div>
      </section>
      <section class="card" aria-labelledby="groupsTitle">
        <div class="section-head">
          <h2 id="groupsTitle">Consumer Groups<span class="count" id="groupsCount"></span></h2>
          <label><span class="sr-only">Filter consumer groups</span><input type="search" id="groupFilter" placeholder="Filter groups" /></label>
        </div>
        <div class="scroll" id="groupsBody"></div>
      </section>
    </div>

    <section class="card" aria-labelledby="topicsTitle" id="topicsSection">
      <div class="section-head">
        <h2 id="topicsTitle">Topics<span class="count" id="topicsCount"></span></h2>
        <div class="toolbar">
          <label class="inline"><input type="checkbox" id="unhealthyOnly" /> Unhealthy only</label>
          <label><span class="sr-only">Filter topics</span><input type="search" id="topicFilter" placeholder="Filter topics" /></label>
        </div>
      </div>
      <div class="scroll" id="topicsBody"></div>
    </section>
    <div class="sub" id="staleNote" hidden></div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${sharedScript}
    const saved = vscode.getState() || {};
    const state = {
      overview: null,
      issues: [],
      updatedAt: '',
      connection: 'disconnected',
      failures: 0,
      topicSort: saved.topicSort || { key: 'name', dir: 1 },
      groupSort: saved.groupSort || { key: 'totalLag', dir: -1 },
      autoRefresh: saved.autoRefresh || 0,
    };
    const MAX_FAILURES = 3;
    let timer = null;

    function persist() {
      vscode.setState({ topicSort: state.topicSort, groupSort: state.groupSort, autoRefresh: state.autoRefresh });
    }

    const CONN = {
      connected: ['good', 'Connected'],
      connecting: ['warn', 'Connecting…'],
      error: ['crit', 'Connection failed'],
      disconnected: ['idle', 'Disconnected'],
    };

    function renderConnection(status, error) {
      state.connection = status;
      const [level, text] = CONN[status] || CONN.disconnected;
      $('connChip').innerHTML = dot(level) + '<span>' + esc(text) + '</span>';
      $('actions').hidden = status !== 'connected';
      const offline = status !== 'connected';
      $('disconnected').hidden = !offline;
      if (offline) {
        $('content').hidden = true;
        $('skeleton').hidden = true;
        $('failure').hidden = true;
        $('discTitle').textContent = status === 'error' ? ${scriptValue(this.cluster.name)} + ' couldn’t connect'
          : status === 'connecting' ? 'Connecting to ' + ${scriptValue(this.cluster.name)} + '…'
          : ${scriptValue(this.cluster.name)} + ' is disconnected';
        $('discText').textContent = status === 'error' && error ? error
          : 'Connect to load broker health, topics and consumer lag. Nothing is fetched until you do.';
        $('connectBtn').disabled = status === 'connecting';
        $('connectBtn').textContent = status === 'error' ? 'Retry' : 'Connect';
        $('discOutputBtn').hidden = status !== 'error';
      } else if (!state.overview) {
        $('skeleton').hidden = false;
      }
    }

    function tile(label, value, hint, level) {
      return '<div class="tile"><div class="label">' + esc(label) + '</div>' +
        '<div class="value">' + value + '</div>' +
        '<div class="hint">' + (level ? dot(level) : '') + esc(hint || '') + '</div></div>';
    }

    function renderTiles(o) {
      const t = o.totals;
      const lag = big(t.totalLag);
      $('tiles').innerHTML = [
        tile('Brokers', fmt.format(t.brokers), o.controllerId == null ? 'no controller' : 'controller #' + o.controllerId, o.controllerId == null ? 'crit' : ''),
        tile('Topics', fmt.format(t.topics), 'excl. internal'),
        tile('Partitions', fmt.format(t.partitions), t.topics ? 'avg ' + (t.partitions / t.topics).toFixed(1) + ' / topic' : ''),
        tile('Under-replicated', fmt.format(t.underReplicated), t.underReplicated ? 'ISR < replicas' : 'healthy', t.underReplicated ? 'warn' : 'good'),
        tile('Offline', fmt.format(t.offline), t.offline ? 'no leader' : 'healthy', t.offline ? 'crit' : 'good'),
        tile('Consumer groups', fmt.format(t.groups), o.groups.filter((g) => g.state === 'Stable').length + ' stable'),
        tile('Total lag', '<span title="' + esc(fmtBig(t.totalLag)) + ' messages">' + compact.format(lag) + '</span>', 'messages behind', lag > 0n ? 'warn' : 'good'),
      ].join('');
    }

    function renderBanner(o) {
      const issues = state.issues;
      const banner = $('banner');
      if (!issues.length) {
        banner.innerHTML = '<span class="icon-good">' + ${scriptValue(icons.check)} + '</span><div class="body"><div><strong>Cluster healthy.</strong> All ' +
          fmt.format(o.totals.partitions) + ' partitions have a leader and a full ISR.</div></div>';
        return;
      }
      const crit = issues.some((i) => i.level === 'crit');
      const shown = issues.slice(0, 6).map((i) => {
        const label = '<span class="lvl-' + i.level + '">' + (i.level === 'crit' ? 'Critical' : 'Warning') + '</span> ';
        const link = i.name ? '<a class="link" data-open="' + i.kind + '" data-name="' + esc(i.name) + '">' + esc(i.name) + '</a>' : '';
        return '<span>' + label + (i.kind === 'group' ? link + ' ' + esc(i.text) : esc(i.text) + ' ' + link) + '</span>';
      }).join('');
      const more = issues.length > 6 ? '<span class="muted">+' + (issues.length - 6) + ' more</span>' : '';
      banner.innerHTML = '<span class="icon-' + (crit ? 'crit' : 'warn') + '">' + ${scriptValue(icons.warning)} + '</span>' +
        '<div class="body"><strong>' + (crit ? 'Cluster needs attention' : 'Warnings') + ' · ' + issues.length + ' issue' + (issues.length === 1 ? '' : 's') + '</strong>' +
        '<div class="issues">' + shown + more + '</div></div>' +
        (o.topics.some((t) => t.offline || t.underReplicated) ? '<button class="small secondary" id="showUnhealthy">Show unhealthy</button>' : '');
    }

    function renderBrokers(o) {
      $('brokersCount').textContent = o.brokers.length;
      if (!o.brokers.length) { $('brokersBody').innerHTML = '<div class="empty">No brokers reported.</div>'; return; }
      const maxLeaders = BigInt(Math.max(0, ...o.brokers.map((b) => b.leaderCount)));
      const cols = [{ label: 'ID' }, { label: 'Host' }, { label: 'Role' }, { label: 'Leaders', num: true }, { label: 'Leader share' }, { label: 'Replicas', num: true }];
      const rows = o.brokers.map((b) => '<tr>' +
        '<td>' + b.nodeId + '</td>' +
        '<td class="mono">' + esc(b.host + ':' + b.port) + '</td>' +
        '<td>' + (b.isController ? '<span class="chip">Controller</span>' : '<span class="muted">Broker</span>') + '</td>' +
        '<td class="num">' + fmt.format(b.leaderCount) + '</td>' +
        '<td class="barcell">' + bar(String(b.leaderCount), maxLeaders, b.leaderCount + ' of ' + o.totals.partitions + ' partition leaders') + '</td>' +
        '<td class="num">' + fmt.format(b.replicaCount) + '</td>' +
        '</tr>').join('');
      $('brokersBody').innerHTML = '<table>' + sortHeader(cols) + '<tbody>' + rows + '</tbody></table>';
    }

    const GROUP_STATE = { Stable: 'good', Empty: 'idle', PreparingRebalance: 'warn', CompletingRebalance: 'warn', Dead: 'crit' };
    const GROUP_LABEL = { PreparingRebalance: 'Rebalancing', CompletingRebalance: 'Rebalancing' };

    function sortRows(rows, sort, bigKeys, nameKey) {
      const { key, dir } = sort;
      return rows.slice().sort((a, b) => {
        const r = bigKeys.includes(key) ? cmpBig(a[key], b[key])
          : typeof a[key] === 'number' ? a[key] - b[key]
          : String(a[key]).localeCompare(String(b[key]));
        return r * dir || String(a[nameKey]).localeCompare(String(b[nameKey]));
      });
    }

    function noMatch(what, inputId, total) {
      if (!total) return '<div class="empty">No ' + what + '.</div>';
      const q = $(inputId).value.trim();
      return '<div class="empty"><span>No ' + what + ' match' + (q ? ' “' + esc(q) + '”' : ' the filters') + '.</span>' +
        '<button class="small secondary" data-clear="' + inputId + '">Clear filter</button></div>';
    }

    function renderGroups(o) {
      const q = $('groupFilter').value.trim().toLowerCase();
      const list = sortRows(o.groups.filter((g) => !q || g.groupId.toLowerCase().includes(q)), state.groupSort, ['totalLag'], 'groupId');
      $('groupsCount').textContent = (q ? list.length + ' of ' : '') + o.groups.length;
      if (!list.length) { $('groupsBody').innerHTML = noMatch('consumer groups', 'groupFilter', o.groups.length); return; }
      const maxLag = maxBig(o.groups.map((g) => g.totalLag));
      const cols = [
        { label: 'Group', key: 'groupId' }, { label: 'State', key: 'state' }, { label: 'Members', key: 'memberCount', num: true },
        { label: 'Lag', key: 'totalLag', num: true }, { label: '' },
      ];
      const rows = list.map((g) => '<tr class="link" tabindex="0" data-group="' + esc(g.groupId) + '" title="Open group details">' +
        '<td class="name">' + esc(g.groupId) + '<div class="sub">' + esc(g.topics.join(', ') || 'no committed offsets') + '</div></td>' +
        '<td>' + badge(GROUP_STATE[g.state] || 'warn', GROUP_LABEL[g.state] || g.state) + '</td>' +
        '<td class="num">' + fmt.format(g.memberCount) + '</td>' +
        '<td class="num">' + fmtBig(g.totalLag) + '</td>' +
        '<td class="barcell">' + bar(g.totalLag, maxLag, fmtBig(g.totalLag) + ' messages behind') + '</td>' +
        '</tr>').join('');
      $('groupsBody').innerHTML = '<table>' + sortHeader(cols, state.groupSort, 'group') + '<tbody>' + rows + '</tbody></table>';
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
      const list = sortRows(withHealth.filter((t) => (!q || t.name.toLowerCase().includes(q)) && (!unhealthy || t.issues > 0)), state.topicSort, ['messageCount'], 'name');
      $('topicsCount').textContent = (q || unhealthy ? list.length + ' of ' : '') + o.topics.length;
      if (!list.length) { $('topicsBody').innerHTML = noMatch('topics', 'topicFilter', o.topics.length); return; }
      const maxMsgs = maxBig(o.topics.map((t) => t.messageCount));
      const cols = [
        { label: 'Topic', key: 'name' }, { label: 'Partitions', key: 'partitionCount', num: true },
        { label: 'RF', key: 'replicationFactor', num: true }, { label: 'Health', key: 'issues' },
        { label: 'Messages', key: 'messageCount', num: true }, { label: '' },
      ];
      const rows = list.map((t) => {
        const [level, text] = topicHealth(t);
        return '<tr class="link' + (t.offline ? ' row-crit' : '') + '" tabindex="0" data-topic="' + esc(t.name) + '" title="Browse messages">' +
          '<td class="name">' + esc(t.name) + '</td>' +
          '<td class="num">' + fmt.format(t.partitionCount) + '</td>' +
          '<td class="num">' + t.replicationFactor + '</td>' +
          '<td>' + badge(level, text) + '</td>' +
          '<td class="num">' + fmtBig(t.messageCount) + '</td>' +
          '<td class="barcell">' + bar(t.messageCount, maxMsgs, fmtBig(t.messageCount) + ' messages retained') + '</td>' +
          '</tr>';
      }).join('');
      $('topicsBody').innerHTML = '<table>' + sortHeader(cols, state.topicSort, 'topic') + '<tbody>' + rows + '</tbody></table>';
    }

    function renderAll() {
      const o = state.overview;
      if (!o || state.connection !== 'connected') return;
      $('skeleton').hidden = true;
      $('content').hidden = false;
      $('clusterMeta').textContent = (o.clusterId ? ' · cluster ' + o.clusterId : '') + ' · updated ' + state.updatedAt;
      renderTiles(o);
      renderBanner(o);
      renderBrokers(o);
      renderGroups(o);
      renderTopics(o);
    }

    function setStale(failed, text) {
      $('failure').hidden = !failed;
      $('content').classList.toggle('stale', failed && !!state.overview);
      if (failed) $('failureText').textContent = text;
      const note = $('staleNote');
      note.hidden = !failed || !state.overview;
      if (!note.hidden) {
        note.innerHTML = ${scriptValue(icons.clock)} + ' Showing data from ' + esc(state.updatedAt) +
          (timer === null && state.failures >= MAX_FAILURES ? ' · auto-refresh paused after ' + MAX_FAILURES + ' failures' : '');
      }
      if (failed && !state.overview) $('skeleton').hidden = true;
    }

    function startTimer() {
      if (timer) clearInterval(timer);
      timer = state.autoRefresh > 0 ? setInterval(() => vscode.postMessage({ command: 'refresh' }), state.autoRefresh * 1000) : null;
    }

    function setAutoRefresh(seconds) {
      state.autoRefresh = seconds;
      state.failures = 0;
      persist();
      startTimer();
    }

    function openRow(tr) {
      if (!tr) return;
      if (tr.dataset.topic != null) vscode.postMessage({ command: 'openTopic', topic: tr.dataset.topic });
      else if (tr.dataset.group != null) vscode.postMessage({ command: 'openGroup', groupId: tr.dataset.group });
    }

    function sortBy(th) {
      const sortKey = th.dataset.table === 'topic' ? 'topicSort' : 'groupSort';
      const cur = state[sortKey];
      const numeric = th.classList.contains('num') || th.dataset.key === 'issues';
      state[sortKey] = cur.key === th.dataset.key ? { key: cur.key, dir: -cur.dir } : { key: th.dataset.key, dir: numeric ? -1 : 1 };
      persist();
      renderAll();
    }

    document.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-key]');
      if (th) { sortBy(th); return; }
      const open = e.target.closest('[data-open]');
      if (open) {
        vscode.postMessage(open.dataset.open === 'group'
          ? { command: 'openGroup', groupId: open.dataset.name }
          : { command: 'openTopic', topic: open.dataset.name });
        return;
      }
      const clear = e.target.closest('[data-clear]');
      if (clear) {
        $(clear.dataset.clear).value = '';
        if (clear.dataset.clear === 'topicFilter') $('unhealthyOnly').checked = false;
        renderAll();
        return;
      }
      if (e.target.closest('#showUnhealthy')) {
        $('unhealthyOnly').checked = true;
        renderTopics(state.overview);
        $('topicsSection').scrollIntoView({ behavior: 'smooth' });
        return;
      }
      openRow(e.target.closest('tr.link'));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.matches('tr.link')) { e.preventDefault(); openRow(e.target); }
      else if (e.target.matches('th[data-key]')) { e.preventDefault(); sortBy(e.target); }
    });

    const refresh = () => vscode.postMessage({ command: 'refresh' });
    $('refreshBtn').addEventListener('click', refresh);
    $('retryBtn').addEventListener('click', () => { state.failures = 0; startTimer(); refresh(); });
    $('connectBtn').addEventListener('click', () => vscode.postMessage({ command: 'connect' }));
    $('discOutputBtn').addEventListener('click', () => vscode.postMessage({ command: 'showOutput' }));
    $('failOutputBtn').addEventListener('click', () => vscode.postMessage({ command: 'showOutput' }));
    $('autoRefresh').addEventListener('change', (e) => setAutoRefresh(Number(e.target.value)));
    $('topicFilter').addEventListener('input', () => state.overview && renderTopics(state.overview));
    $('unhealthyOnly').addEventListener('change', () => state.overview && renderTopics(state.overview));
    $('groupFilter').addEventListener('input', () => state.overview && renderGroups(state.overview));

    $('autoRefresh').value = String(state.autoRefresh);
    startTimer();

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'connection':
          renderConnection(message.status, message.error);
          renderAll();
          break;
        case 'loading':
          $('progress').classList.toggle('active', message.value);
          $('refreshBtn').disabled = message.value;
          break;
        case 'overview':
          state.overview = message.overview;
          state.issues = message.issues;
          state.updatedAt = message.at;
          state.failures = 0;
          if (!timer && state.autoRefresh > 0) startTimer();
          setStale(false);
          renderAll();
          break;
        case 'failed':
          state.failures += 1;
          if (state.failures >= MAX_FAILURES && timer) { clearInterval(timer); timer = null; }
          setStale(true, message.text);
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
