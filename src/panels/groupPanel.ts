import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { planReset } from "../kafka/offsets";
import { ClusterConfig, GroupOffsetEntry, ResetSpec } from "../kafka/types";
import { baseCss, contentSecurityPolicy, createNonce, escapeHtml, icons, scriptValue, sharedScript } from "./webview";

type WebviewInMessage =
  | { command: "refresh" }
  | { command: "preview"; topic: string; spec: ResetSpec }
  | { command: "reset"; topic: string; spec: ResetSpec }
  | { command: "editOffset"; topic: string; partition: number }
  | { command: "deleteGroup" };

/**
 * One webview panel per (cluster, group). Reused if already open instead of
 * spawning duplicates.
 */
export class GroupPanel {
  private static readonly panels = new Map<string, GroupPanel>();

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private offsets: GroupOffsetEntry[] = [];

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
    switch (message.command) {
      case "refresh":
        await this.load();
        break;
      case "preview":
        this.postPreview(message.topic, message.spec);
        break;
      case "reset":
        await this.reset(message.topic, message.spec);
        break;
      case "editOffset":
        await this.editOffset(message.topic, message.partition);
        break;
      case "deleteGroup":
        await this.deleteGroup();
        break;
    }
  }

  private async load(): Promise<void> {
    this.post({ command: "loading", value: true });
    try {
      const [details, offsets] = await Promise.all([
        this.manager.getGroupDetails(this.cluster, this.groupId),
        this.manager.fetchGroupOffsets(this.cluster, this.groupId),
      ]);
      this.offsets = offsets;
      this.post({ command: "data", details, offsets, at: new Date().toLocaleTimeString() });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load group: ${describeError(error)}`, error: true });
    } finally {
      this.post({ command: "loading", value: false });
    }
  }

  private postPreview(topic: string, spec: ResetSpec): void {
    if (spec.mode === "timestamp") {
      const partitions = this.offsets.filter((o) => o.topic === topic).length;
      this.post({ command: "preview", preview: { partitions, lagBefore: null, lagAfter: null } });
      return;
    }
    const preview = planReset(this.offsets, topic, spec);
    this.post({
      command: "preview",
      preview: {
        partitions: preview.moves.filter((m) => m.from !== m.to).length,
        lagBefore: preview.lagBefore,
        lagAfter: preview.lagAfter,
      },
    });
  }

  private describeSpec(spec: ResetSpec): string {
    switch (spec.mode) {
      case "earliest":
      case "latest":
        return spec.mode;
      case "timestamp":
        return `the first offset at or after ${new Date(spec.timestamp).toLocaleString()}`;
      case "shift":
        return `${spec.by >= 0 ? "+" : ""}${spec.by} from the committed offset`;
    }
  }

  private async reset(topic: string, spec: ResetSpec): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Reset "${this.groupId}" offsets on "${topic}" to ${this.describeSpec(spec)}?`,
      { modal: true, detail: "Consumers in this group will resume from the new offsets." },
      "Reset"
    );
    if (confirm !== "Reset") {
      this.post({ command: "resetDone", ok: false });
      return;
    }
    try {
      const moves = await this.manager.resetGroupOffsetsTo(this.cluster, this.groupId, topic, spec);
      this.post({ command: "resetDone", ok: true });
      this.post({ command: "status", text: `Reset ${moves.length} partition(s) of "${topic}".` });
      vscode.commands.executeCommand("kafka-manager.refresh");
      await this.load();
    } catch (error) {
      this.post({ command: "resetDone", ok: false });
      this.post({ command: "status", text: `Failed to reset offsets: ${describeError(error)}`, error: true });
    }
  }

  private async editOffset(topic: string, partition: number): Promise<void> {
    const entry = this.offsets.find((o) => o.topic === topic && o.partition === partition);
    if (!entry) {
      return;
    }
    await vscode.commands.executeCommand("kafka-manager.editGroupOffset", {
      cluster: this.cluster,
      groupId: this.groupId,
      entry,
    });
    await this.load();
  }

  private async deleteGroup(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Delete consumer group "${this.groupId}"?`,
      { modal: true, detail: "Its committed offsets are removed. This cannot be undone." },
      "Delete"
    );
    if (confirm !== "Delete") {
      return;
    }
    try {
      await this.manager.deleteConsumerGroup(this.cluster, this.groupId);
      vscode.commands.executeCommand("kafka-manager.refresh");
      this.panel.dispose();
    } catch (error) {
      this.post({ command: "status", text: `Failed to delete group: ${describeError(error)}`, error: true });
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
    const nonce = createNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}" />
<style>
${baseCss}
  body { padding: 0; }
  .layout { display: flex; min-height: 100vh; }
  .main { flex-grow: 1; min-width: 0; padding: 0 20px 24px; }
  aside { width: 380px; flex-shrink: 0; border-left: 1px solid var(--vscode-widget-border, var(--border)); background: var(--vscode-editorWidget-background, var(--card));
    box-shadow: -8px 0 20px var(--vscode-widget-shadow, transparent); padding: 16px; display: flex; flex-direction: column; gap: 14px; position: sticky; top: 0; max-height: 100vh; overflow: auto; }
  aside h2 { font-size: 15px; }
  fieldset { margin: 0; padding: 0; border: none; display: flex; flex-direction: column; gap: 8px; }
  legend { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .choice { display: flex; gap: 8px; align-items: flex-start; }
  .choice input[type=radio] { margin-top: 3px; }
  .choice .extra { margin-top: 6px; }
  .preview { border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
  .preview div { display: flex; justify-content: space-between; }
  .assign { display: flex; gap: 4px; flex-wrap: wrap; white-space: normal; }
  .assign .chip { font-weight: 400; }
  @media (max-width: 900px) { .layout { flex-direction: column; } aside { width: auto; position: static; max-height: none; border-left: none; border-top: 1px solid var(--border); } }
</style>
</head>
<body>
<div class="layout">
  <div class="main">
    <header class="page">
      <div>
        <div class="title"><h1>${escapeHtml(this.groupId)}</h1><span class="chip" id="stateChip"><span class="dot"></span>…</span></div>
        <div class="sub" id="meta">${escapeHtml(this.cluster.name)}</div>
      </div>
      <div class="toolbar">
        <button class="secondary" id="refreshBtn">${icons.refresh}Refresh</button>
        <button id="resetOpenBtn" aria-expanded="false" aria-controls="resetPanel">Reset Offsets…</button>
        <button class="danger" id="deleteBtn">Delete Group</button>
      </div>
    </header>
    <div class="progress" id="progress"></div>
    <div id="status" role="status" style="margin-bottom:10px"></div>

    <div class="stack">
      <div class="tiles" id="tiles"></div>

      <section class="card" aria-labelledby="membersTitle">
        <div class="section-head"><h2 id="membersTitle">Members<span class="count" id="membersCount"></span></h2></div>
        <div class="scroll" id="membersBody"></div>
      </section>

      <section class="card" aria-labelledby="lagTitle">
        <div class="section-head">
          <h2 id="lagTitle">Partition lag<span class="count" id="lagCount"></span></h2>
          <label class="inline" for="lagTopic">Topic <select id="lagTopic"></select></label>
        </div>
        <div class="scroll" id="lagBody"></div>
      </section>
    </div>
  </div>

  <aside id="resetPanel" role="dialog" aria-labelledby="resetTitle" hidden>
    <div class="section-head" style="margin:0">
      <h2 id="resetTitle">Reset offsets</h2>
      <button class="icon" id="resetCloseBtn" aria-label="Close">${icons.close}</button>
    </div>
    <label class="field">Topic<select id="resetTopic"></select></label>
    <fieldset>
      <legend>Move to</legend>
      <label class="choice"><input type="radio" name="mode" value="earliest" /><span>Earliest<br /><span class="sub">Reprocess everything retained</span></span></label>
      <label class="choice"><input type="radio" name="mode" value="latest" checked /><span>Latest<br /><span class="sub" id="latestHint">Skip the current backlog</span></span></label>
      <label class="choice"><input type="radio" name="mode" value="timestamp" /><span>Timestamp<br /><span class="sub">First offset at or after a time</span>
        <div class="extra" id="tsWrap" hidden><label><span class="sr-only">Timestamp</span><input type="datetime-local" id="tsInput" step="1" /></label></div></span></label>
      <label class="choice"><input type="radio" name="mode" value="shift" /><span>Shift by N<br /><span class="sub">e.g. −1000 to replay recent messages</span>
        <div class="extra" id="shiftWrap" hidden><label><span class="sr-only">Shift by</span><input type="number" id="shiftInput" value="-1000" step="1" style="width:140px" /></label></div></span></label>
    </fieldset>
    <div class="preview" aria-live="polite">
      <strong>Preview</strong>
      <div><span class="muted">Partitions changed</span><span id="pvParts">–</span></div>
      <div><span class="muted">Lag now</span><span id="pvBefore">–</span></div>
      <div><span class="muted">Lag after reset</span><span id="pvAfter">–</span></div>
      <div><span class="muted" id="pvDeltaLabel">Change</span><span id="pvDelta">–</span></div>
    </div>
    <div class="alert warn" id="activeWarning" role="alert" hidden>
      ${icons.warning}
      <span id="activeWarningText"></span>
    </div>
    <div class="toolbar" style="margin-top:auto;justify-content:flex-end">
      <button class="secondary" id="resetCancelBtn">Cancel</button>
      <button id="resetApplyBtn">Reset</button>
    </div>
  </aside>
</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${sharedScript}
    const state = { details: null, offsets: [], at: '', lagTopic: '' };
    const GROUP_STATE = { Stable: 'good', Empty: 'idle', PreparingRebalance: 'warn', CompletingRebalance: 'warn', Dead: 'crit' };
    const GROUP_LABEL = { PreparingRebalance: 'Rebalancing', CompletingRebalance: 'Rebalancing' };

    function tile(label, value, hint) {
      return '<div class="tile"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div><div class="hint">' + esc(hint || '') + '</div></div>';
    }

    function owners() {
      const map = new Map();
      for (const m of state.details.members) {
        for (const a of m.assignment) for (const p of a.partitions) map.set(a.topic + ':' + p, m);
      }
      return map;
    }

    function topics() { return [...new Set(state.offsets.map((o) => o.topic))].sort(); }

    function render() {
      const d = state.details;
      const level = GROUP_STATE[d.state] || 'warn';
      $('stateChip').innerHTML = dot(level) + esc(GROUP_LABEL[d.state] || d.state);
      $('meta').textContent = [${scriptValue(this.cluster.name)}, d.protocol && 'protocol ' + d.protocol, d.protocolType, 'updated ' + state.at].filter(Boolean).join(' · ');

      let total = 0n, max = null;
      for (const o of state.offsets) {
        total += big(o.lag);
        if (!max || big(o.lag) > big(max.lag)) max = o;
      }
      const tcount = topics().length;
      $('tiles').innerHTML = [
        tile('Members', fmt.format(d.members.length), d.members.length ? (level === 'warn' ? 'rebalance in progress' : 'active') : 'no active consumers'),
        tile('Partitions', fmt.format(state.offsets.length), tcount + ' topic' + (tcount === 1 ? '' : 's')),
        tile('Total lag', '<span title="' + esc(fmtBig(total.toString())) + '">' + compact.format(total) + '</span>', 'messages behind'),
        tile('Max partition lag', max ? compact.format(big(max.lag)) : '0', max && big(max.lag) > 0n ? max.topic + ' / ' + max.partition : 'caught up'),
      ].join('');

      $('membersCount').textContent = d.members.length;
      $('membersBody').innerHTML = d.members.length
        ? '<table><thead><tr><th>Member</th><th>Client ID</th><th>Host</th><th>Assignment</th></tr></thead><tbody>' +
          d.members.map((m) => '<tr><td class="mono name" title="' + esc(m.memberId) + '">' + esc(m.memberId) + '</td><td>' + esc(m.clientId) + '</td><td class="muted">' + esc(m.clientHost) + '</td>' +
            '<td><div class="assign">' + (m.assignment.flatMap((a) => a.partitions.map((p) => '<span class="chip">' + esc(a.topic + ' ' + p) + '</span>')).join('') || '<span class="muted">none</span>') + '</div></td></tr>').join('') +
          '</tbody></table>'
        : '<div class="empty">No active members. Offsets can be reset while the group is empty.</div>';

      const ts = topics();
      if (!ts.includes(state.lagTopic)) state.lagTopic = ts[0] || '';
      const options = ts.map((t) => '<option>' + esc(t) + '</option>').join('');
      $('lagTopic').innerHTML = options;
      $('lagTopic').value = state.lagTopic;
      const resetTopic = $('resetTopic').value;
      $('resetTopic').innerHTML = ts.map((t) => '<option>' + esc(t) + '</option>').join('');
      $('resetTopic').value = ts.includes(resetTopic) ? resetTopic : state.lagTopic;
      renderLag();
      updateActiveWarning();
      if (!$('resetPanel').hidden) requestPreview();
    }

    function renderLag() {
      const rows = state.offsets.filter((o) => o.topic === state.lagTopic).sort((a, b) => cmpBig(b.lag, a.lag) || a.partition - b.partition);
      $('lagCount').textContent = rows.length ? rows.length : '';
      if (!rows.length) { $('lagBody').innerHTML = '<div class="empty">No committed offsets.</div>'; return; }
      const max = maxBig(rows.map((r) => r.lag));
      const own = owners();
      $('lagBody').innerHTML = '<table><thead><tr><th>Partition</th><th class="num">Committed</th><th class="num">Latest</th><th class="num">Lag ▾</th><th></th><th>Consumer</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        rows.map((r) => {
          const m = own.get(r.topic + ':' + r.partition);
          return '<tr><td>' + r.partition + '</td>' +
            '<td class="num">' + (r.offset === '-1' ? '<span class="muted">none</span>' : fmtBig(r.offset)) + '</td>' +
            '<td class="num">' + fmtBig(r.high) + '</td>' +
            '<td class="num">' + fmtBig(r.lag) + '</td>' +
            '<td class="barcell">' + bar(r.lag, max, fmtBig(r.lag) + ' messages behind') + '</td>' +
            '<td class="muted">' + (m ? esc(m.clientId) + ' <span class="mono">' + esc(m.memberId.slice(-8)) + '</span>' : '—') + '</td>' +
            '<td><button class="icon" data-edit="' + r.partition + '" aria-label="Edit offset for partition ' + r.partition + '" title="Edit offset">' + ${scriptValue(icons.edit)} + '</button></td></tr>';
        }).join('') + '</tbody></table>';
    }

    function currentSpec() {
      const mode = document.querySelector('input[name=mode]:checked').value;
      if (mode === 'timestamp') {
        const t = new Date($('tsInput').value).getTime();
        return isNaN(t) ? null : { mode, timestamp: t };
      }
      if (mode === 'shift') {
        const by = Number($('shiftInput').value);
        return Number.isFinite(by) && by !== 0 ? { mode, by: Math.trunc(by) } : null;
      }
      return { mode };
    }

    function requestPreview() {
      const mode = document.querySelector('input[name=mode]:checked').value;
      $('tsWrap').hidden = mode !== 'timestamp';
      $('shiftWrap').hidden = mode !== 'shift';
      const spec = currentSpec();
      updateApply();
      if (!spec || !$('resetTopic').value) { renderPreview(null); return; }
      vscode.postMessage({ command: 'preview', topic: $('resetTopic').value, spec });
    }

    function renderPreview(p) {
      $('pvParts').textContent = p ? fmt.format(p.partitions) : '–';
      $('pvBefore').textContent = p && p.lagBefore != null ? fmtBig(p.lagBefore) : '–';
      $('pvAfter').textContent = p && p.lagAfter != null ? fmtBig(p.lagAfter) : (p ? 'calculated on reset' : '–');
      if (p && p.lagBefore != null) {
        const delta = big(p.lagAfter) - big(p.lagBefore);
        $('pvDeltaLabel').textContent = delta > 0n ? 'Messages replayed' : 'Messages skipped';
        $('pvDelta').textContent = fmt.format(delta < 0n ? -delta : delta);
        $('pvDelta').style.color = delta < 0n ? 'var(--warn)' : '';
      } else {
        $('pvDeltaLabel').textContent = 'Change';
        $('pvDelta').textContent = '–';
        $('pvDelta').style.color = '';
      }
      const topicTotal = state.offsets.filter((o) => o.topic === $('resetTopic').value).reduce((s, o) => s + big(o.lag), 0n);
      $('latestHint').textContent = topicTotal > 0n ? 'Skip the ' + fmt.format(topicTotal) + '-message backlog' : 'Nothing to skip — already caught up';
      $('resetApplyBtn').textContent = p && p.partitions ? 'Reset ' + p.partitions + ' partition' + (p.partitions === 1 ? '' : 's') : 'Reset';
    }

    function updateActiveWarning() {
      const n = state.details ? state.details.members.length : 0;
      $('activeWarning').hidden = n === 0;
      $('activeWarningText').textContent = n + ' member' + (n === 1 ? ' is' : 's are') + ' active. Kafka rejects offset changes while the group is running — stop the consumers first.';
      updateApply();
    }

    function updateApply() {
      const active = state.details && state.details.members.length > 0;
      $('resetApplyBtn').disabled = !!active || !currentSpec() || !$('resetTopic').value;
    }

    function openReset(open) {
      $('resetPanel').hidden = !open;
      $('resetOpenBtn').setAttribute('aria-expanded', String(open));
      if (open) { requestPreview(); $('resetTopic').focus(); }
      else $('resetOpenBtn').focus();
    }

    $('refreshBtn').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    $('deleteBtn').addEventListener('click', () => vscode.postMessage({ command: 'deleteGroup' }));
    $('resetOpenBtn').addEventListener('click', () => openReset($('resetPanel').hidden));
    $('resetCloseBtn').addEventListener('click', () => openReset(false));
    $('resetCancelBtn').addEventListener('click', () => openReset(false));
    $('resetPanel').addEventListener('keydown', (e) => { if (e.key === 'Escape') openReset(false); });
    $('lagTopic').addEventListener('change', (e) => { state.lagTopic = e.target.value; renderLag(); });
    $('resetTopic').addEventListener('change', requestPreview);
    document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', requestPreview));
    $('tsInput').addEventListener('input', requestPreview);
    $('shiftInput').addEventListener('input', requestPreview);
    $('resetApplyBtn').addEventListener('click', () => {
      const spec = currentSpec();
      if (!spec) return;
      $('resetApplyBtn').disabled = true;
      vscode.postMessage({ command: 'reset', topic: $('resetTopic').value, spec });
    });
    $('lagBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-edit]');
      if (btn) vscode.postMessage({ command: 'editOffset', topic: state.lagTopic, partition: Number(btn.dataset.edit) });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'data':
          state.details = message.details;
          state.offsets = message.offsets;
          state.at = message.at;
          render();
          break;
        case 'preview':
          renderPreview(message.preview);
          break;
        case 'resetDone':
          updateApply();
          if (message.ok) openReset(false);
          break;
        case 'loading':
          $('progress').classList.toggle('active', message.value);
          $('refreshBtn').disabled = message.value;
          break;
        case 'status':
          $('status').textContent = message.text;
          $('status').classList.toggle('error', !!message.error);
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}
