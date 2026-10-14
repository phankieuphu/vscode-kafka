import * as crypto from "crypto";
import * as vscode from "vscode";
import { ClusterManager } from "../kafka/clusterManager";
import { actionsFor, AssistantAction, AssistantRequest, prepareAssistant, runPrepared } from "../ai/assistant";
import { assistantDeps } from "../ai/chat";
import { CHIPS, PanelAction, PanelOutMessage, parsePanelMessage, toBlocks } from "../ai/chatPanelProtocol";
import { renderMarkdown } from "../ai/markdown";
import { onDidChangeAiAvailability, prepareModel, selectModel } from "../ai/model";
import { AiTask } from "../ai/prompts";
import { AiMessage } from "../ai/providers/types";
import { isAiAvailable } from "../ai/settings";
import { AiOutput } from "../ai/stream";
import { baseCss, contentSecurityPolicy, createNonce, escapeHtml, markdownCss, sharedScript } from "./webview";

/** A question to ask as soon as the panel is open (from an Explain/Ask AI button). */
export interface PanelAsk extends AssistantRequest {
  /** What the user's bubble shows, e.g. "Explain this message". */
  label: string;
}

const RENDER_INTERVAL_MS = 60;
const MAX_HISTORY = 12;

/**
 * The Kafka AI chat panel: one per cluster, beside the dashboard and topic
 * panels. Uses the same request path as `@kafka` (assistant.ts), with any
 * provider: Claude, GPT, Gemini, OpenRouter, Ollama or VS Code's models.
 * Conversation history lives only while the panel is open.
 */
export class AiChatPanel {
  private static readonly panels = new Map<string, AiChatPanel>();
  private static state: vscode.Memento | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private history: AiMessage[] = [];
  private readonly actions = new Map<string, AssistantAction>();
  private running: vscode.CancellationTokenSource | undefined;
  private ready = false;
  private queued: PanelAsk | undefined;
  private disposed = false;

  static setState(state: vscode.Memento): void {
    AiChatPanel.state = state;
  }

  /** Opens (or reveals) the panel for `clusterId`, then asks `ask` if given. */
  static show(manager: ClusterManager, clusterId: string | undefined, ask?: PanelAsk): void {
    if (!isAiAvailable()) {
      void vscode.window.showWarningMessage(
        vscode.workspace.isTrusted ? "Kafka AI is turned off (kafka.ai.enabled)." : "Kafka AI is disabled in untrusted workspaces.",
      );
      return;
    }
    const id = clusterId ?? manager.getClusters().find((c) => manager.getStatus(c.id) === "connected")?.id ?? manager.getClusters()[0]?.id ?? "";
    let instance = AiChatPanel.panels.get(id);
    if (instance) {
      instance.panel.reveal(undefined, true);
    } else {
      const name = manager.getCluster(id)?.name;
      const panel = vscode.window.createWebviewPanel(
        "kafkaAiChat",
        name ? `Kafka AI: ${name}` : "Kafka AI",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.iconPath = new vscode.ThemeIcon("sparkle");
      instance = new AiChatPanel(panel, manager, id);
      AiChatPanel.panels.set(id, instance);
    }
    if (ask) {
      instance.enqueue(ask);
    }
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly manager: ClusterManager,
    private clusterId: string,
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();
    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((raw) => this.handle(raw)),
      this.panel.onDidDispose(() => this.dispose()),
      manager.onDidChangeStatus(() => this.postClusters()),
      manager.onDidChangeClusters(() => this.postClusters()),
      onDidChangeAiAvailability(() => {
        if (!isAiAvailable()) {
          this.panel.dispose();
          return;
        }
        void this.postModel();
      }),
    );
  }

  private enqueue(ask: PanelAsk): void {
    if (this.ready) {
      void this.ask(ask);
    } else {
      this.queued = ask;
    }
  }

  private post(message: PanelOutMessage): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private clusters() {
    return this.manager.getClusters().map((c) => ({ id: c.id, name: c.name, status: this.manager.getStatus(c.id) }));
  }

  private postClusters(): void {
    if (this.clusterId && !this.manager.getCluster(this.clusterId)) {
      this.clusterId = this.manager.getClusters()[0]?.id ?? "";
    }
    this.post({ command: "clusters", clusters: this.clusters(), clusterId: this.clusterId || undefined });
  }

  private async postModel(): Promise<void> {
    const choice = await selectModel();
    this.post("problem" in choice ? { command: "model", problem: choice.problem } : { command: "model", label: `${choice.model.name} · ${choice.model.providerLabel}` });
  }

  private async handle(raw: unknown): Promise<void> {
    const message = parsePanelMessage(raw);
    if (!message) {
      return;
    }
    switch (message.command) {
      case "ready":
        this.ready = true;
        this.post({ command: "init", clusters: this.clusters(), clusterId: this.clusterId || undefined });
        void this.postModel();
        if (this.queued) {
          const ask = this.queued;
          this.queued = undefined;
          void this.ask(ask);
        }
        break;
      case "ask":
        await this.ask({ task: "ask", prompt: message.text, label: message.text });
        break;
      case "chip":
        await this.chip(message.task);
        break;
      case "stop":
        this.running?.cancel();
        break;
      case "clear":
        this.running?.cancel();
        this.history = [];
        this.actions.clear();
        this.post({ command: "cleared" });
        break;
      case "selectCluster":
        if (this.manager.getCluster(message.clusterId)) {
          this.rekey(message.clusterId);
        }
        break;
      case "action": {
        const action = this.actions.get(message.id);
        if (action) {
          void vscode.commands.executeCommand(action.command, ...action.args);
        }
        break;
      }
      case "setup":
        void vscode.commands.executeCommand("kafka-manager.aiSetup");
        break;
    }
  }

  private async chip(task: AiTask): Promise<void> {
    const chip = CHIPS.find((c) => c.task === task)!;
    const ask: PanelAsk = { task, prompt: "", label: chip.prompt, clusterId: this.clusterId };
    if (task === "topic") {
      const cluster = this.manager.getCluster(this.clusterId);
      if (!cluster || this.manager.getStatus(cluster.id) !== "connected") {
        return this.ask(ask);
      }
      const topics = await this.manager.listTopics(cluster).catch(() => []);
      const picked = await vscode.window.showQuickPick(
        topics.map((t) => t.name).sort(),
        { title: "Explain which topic?", placeHolder: "Topic" },
      );
      if (!picked) {
        return;
      }
      ask.target = { topic: picked };
      ask.label = `Explain topic ${picked}`;
    }
    return this.ask(ask);
  }

  private async ask(ask: PanelAsk): Promise<void> {
    if (this.running) {
      this.running.cancel();
    }
    const source = new vscode.CancellationTokenSource();
    this.running = source;
    const token = source.token;
    const turnId = crypto.randomUUID();
    this.post({ command: "user", id: `u-${turnId}`, html: escapeHtml(ask.label) });
    this.post({ command: "assistantStart", id: turnId });
    this.post({ command: "busy", value: true });

    let markdown = "";
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
      timer = undefined;
      this.post({ command: "assistantUpdate", id: turnId, html: renderMarkdown(markdown) });
    };
    const out: AiOutput = {
      write: (text) => {
        markdown += text;
        timer ??= setTimeout(flush, RENDER_INTERVAL_MS);
      },
      progress: (text) => this.post({ command: "progress", id: turnId, text }),
    };
    const end = (actions: AssistantAction[], blocks: ReturnType<typeof toBlocks>, note?: string, error?: boolean) => {
      if (timer) {
        clearTimeout(timer);
      }
      flush();
      const ids: PanelAction[] = actions.map((a) => {
        const id = crypto.randomUUID();
        this.actions.set(id, a);
        return { id, title: a.title };
      });
      this.post({ command: "assistantEnd", id: turnId, blocks, actions: ids, note, error });
      this.post({ command: "busy", value: false });
    };

    try {
      const choice = await prepareModel(AiChatPanel.state!);
      if ("problem" in choice) {
        markdown = choice.problem;
        end([{ title: "Open AI Setup", command: "kafka-manager.aiSetup", args: [] }], [], undefined, true);
        return;
      }
      const deps = await assistantDeps(this.manager);
      out.progress?.("Reading the cluster…");
      const prepared = await prepareAssistant(deps, choice.model, { ...ask, clusterId: ask.clusterId ?? this.clusterId, history: this.history }, token);
      if (prepared.meta.notes.length) {
        markdown += prepared.meta.notes.join("\n\n") + "\n\n";
      }
      if (!prepared.ok) {
        markdown += prepared.message;
        end(prepared.actions, []);
        return;
      }
      if (prepared.meta.cluster && prepared.meta.cluster.id !== this.clusterId) {
        this.rekey(prepared.meta.cluster.id);
        this.postClusters();
      }
      const answer = await runPrepared(deps, choice.model, prepared.built.request, prepared.built.fitted, out, token);
      if (!answer.error && !token.isCancellationRequested) {
        this.history.push({ role: "user", parts: [{ type: "text", text: ask.prompt || ask.label }] }, { role: "assistant", parts: [{ type: "text", text: answer.text }] });
        this.history = this.history.slice(-MAX_HISTORY);
      }
      const notes = [
        token.isCancellationRequested ? "Stopped." : "",
        answer.fitted.dropped.length ? `Left out to fit the model: ${answer.fitted.dropped.join(", ")}.` : "",
        answer.toolCalls.length ? `Looked up: ${[...new Set(answer.toolCalls.map((c) => c.name.replace(/^kafka_/, "")))].join(", ")}.` : "",
        `${choice.model.name} · ${choice.model.providerLabel}`,
      ].filter(Boolean);
      end(actionsFor(prepared.meta), toBlocks(prepared.built.sections), notes.join(" "), !!answer.error);
    } catch (error) {
      markdown += `\n\n**Something went wrong:** ${error instanceof Error ? error.message : String(error)}`;
      end([], [], undefined, true);
    } finally {
      if (this.running === source) {
        this.running = undefined;
      }
      source.dispose();
    }
  }

  /** Follows the cluster the conversation is now about, so Ask AI on it reuses this panel. */
  private rekey(clusterId: string): void {
    if (AiChatPanel.panels.get(this.clusterId) === this) {
      AiChatPanel.panels.delete(this.clusterId);
    }
    this.clusterId = clusterId;
    if (!AiChatPanel.panels.has(clusterId)) {
      AiChatPanel.panels.set(clusterId, this);
    }
    const name = this.manager.getCluster(clusterId)?.name;
    this.panel.title = name ? `Kafka AI: ${name}` : "Kafka AI";
  }

  private dispose(): void {
    this.disposed = true;
    this.running?.cancel();
    for (const [key, value] of AiChatPanel.panels) {
      if (value === this) {
        AiChatPanel.panels.delete(key);
      }
    }
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
${markdownCss}
  body { padding: 0; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  header.topbar, footer { flex: none; }
  header.topbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  header.topbar .grow { flex-grow: 1; }
  #model { font-size: 12px; color: var(--muted); max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #model.problem { color: var(--vscode-errorForeground); }
  #log { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
  .turn { max-width: 100%; line-height: 1.55; }
  .turn.user { align-self: flex-end; background: var(--vscode-input-background); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; max-width: 80%; white-space: pre-wrap; }
  .turn.ai { border-left: 2px solid var(--vscode-charts-purple, var(--bar)); padding: 2px 0 2px 12px; }
  .turn.ai.error { border-left-color: var(--crit); }
  .progress-line { color: var(--muted); font-size: 12px; display: flex; gap: 6px; align-items: center; }
  .progress-line::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-progressBar-background); animation: pulse 1.2s infinite; }
  .blocks { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .blocks details { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px; }
  .blocks summary { cursor: pointer; font-size: 12px; font-weight: 600; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
  .note { font-size: 11px; color: var(--muted); margin-top: 6px; }
  footer { border-top: 1px solid var(--border); padding: 8px 16px 12px; display: flex; flex-direction: column; gap: 8px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .chips button { height: 22px; border-radius: 11px; font-size: 12px; }
  .composer { display: flex; gap: 8px; align-items: flex-end; }
  #input { flex-grow: 1; min-height: 34px; max-height: 160px; font-family: var(--vscode-font-family); font-size: 13px; resize: none; }
  .empty-chat { color: var(--muted); text-align: center; margin: auto; max-width: 420px; line-height: 1.5; }
  .empty-chat .title { font-size: 15px; font-weight: 600; color: var(--vscode-foreground); margin-bottom: 6px; }
</style>
</head>
<body>
  <header class="topbar">
    <label class="inline" for="cluster">Cluster</label>
    <select id="cluster" aria-label="Cluster"></select>
    <span class="grow"></span>
    <a id="model" title="Change the AI provider or model" tabindex="0">…</a>
    <button class="small secondary" id="clearBtn" title="Start a new conversation">Clear</button>
  </header>
  <main id="log" aria-live="polite">
    <div class="empty-chat" id="emptyChat">
      <div class="title">Ask about this cluster</div>
      Health, lag, topics, configs or connection errors. Answers are based on what Kafka Manager reads from the cluster;
      the AI can't change anything. Passwords and keys are never sent.
    </div>
  </main>
  <footer>
    <div class="chips" id="chips">
      ${CHIPS.map((c) => `<button class="secondary" data-chip="${c.task}">${escapeHtml(c.label)}</button>`).join("")}
    </div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Ask Kafka AI… (Enter to send, Shift+Enter for a new line)" aria-label="Question"></textarea>
      <button id="sendBtn">Send</button>
      <button id="stopBtn" class="secondary" hidden>Stop</button>
    </div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${sharedScript}
    const log = $('log');
    const turns = new Map();
    let busy = false;

    function scrollDown() { log.scrollTop = log.scrollHeight; }
    function removeEmpty() { const e = $('emptyChat'); if (e) e.remove(); }

    function setClusters(clusters, id) {
      const select = $('cluster');
      select.innerHTML = clusters.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.name) + (c.status === 'connected' ? '' : ' (' + esc(c.status) + ')') + '</option>').join('');
      if (id) select.value = id;
      select.disabled = clusters.length === 0;
    }

    function addUser(id, html) {
      removeEmpty();
      const div = document.createElement('div');
      div.className = 'turn user';
      div.innerHTML = html;
      log.appendChild(div);
      scrollDown();
    }

    function startAssistant(id) {
      const div = document.createElement('div');
      div.className = 'turn ai';
      div.innerHTML = '<div class="md"></div><div class="progress-line">Thinking…</div>';
      log.appendChild(div);
      turns.set(id, div);
      scrollDown();
    }

    function table(block) {
      return '<details><summary>' + esc(block.title) + ' (' + block.rows.length + ')</summary><div class="scroll"><table><thead><tr>' +
        block.columns.map((c) => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' +
        block.rows.map((r) => '<tr>' + r.map((c) => '<td class="mono">' + esc(c) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div></details>';
    }

    function endAssistant(m) {
      const div = turns.get(m.id);
      if (!div) return;
      const p = div.querySelector('.progress-line');
      if (p) p.remove();
      if (m.error) div.classList.add('error');
      if (m.blocks && m.blocks.length) {
        const blocks = document.createElement('div');
        blocks.className = 'blocks';
        blocks.innerHTML = m.blocks.map(table).join('');
        div.appendChild(blocks);
      }
      if (m.actions && m.actions.length) {
        const actions = document.createElement('div');
        actions.className = 'actions';
        actions.innerHTML = m.actions.map((a) => '<button class="small secondary" data-action="' + esc(a.id) + '">' + esc(a.title) + '</button>').join('');
        div.appendChild(actions);
      }
      if (m.note) {
        const note = document.createElement('div');
        note.className = 'note';
        note.textContent = m.note;
        div.appendChild(note);
      }
      scrollDown();
    }

    function setBusy(value) {
      busy = value;
      $('sendBtn').hidden = value;
      $('stopBtn').hidden = !value;
      document.querySelectorAll('[data-chip]').forEach((b) => (b.disabled = value));
    }

    function send() {
      const text = $('input').value.trim();
      if (!text || busy) return;
      $('input').value = '';
      autosize();
      vscode.postMessage({ command: 'ask', text });
    }

    function autosize() {
      const input = $('input');
      input.style.height = 'auto';
      input.style.height = Math.min(160, input.scrollHeight + 2) + 'px';
    }

    $('input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('input').addEventListener('input', autosize);
    $('sendBtn').addEventListener('click', send);
    $('stopBtn').addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
    $('clearBtn').addEventListener('click', () => vscode.postMessage({ command: 'clear' }));
    $('cluster').addEventListener('change', (e) => vscode.postMessage({ command: 'selectCluster', clusterId: e.target.value }));
    $('model').addEventListener('click', () => vscode.postMessage({ command: 'setup' }));
    $('model').addEventListener('keydown', (e) => { if (e.key === 'Enter') vscode.postMessage({ command: 'setup' }); });
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-chip]');
      if (chip && !busy) { vscode.postMessage({ command: 'chip', task: chip.dataset.chip }); return; }
      const action = e.target.closest('[data-action]');
      if (action) vscode.postMessage({ command: 'action', id: action.dataset.action });
    });

    window.addEventListener('message', (event) => {
      const m = event.data;
      switch (m.command) {
        case 'init':
        case 'clusters':
          setClusters(m.clusters, m.clusterId);
          break;
        case 'model':
          $('model').textContent = m.problem ? 'Set up AI' : m.label;
          $('model').title = m.problem || 'Change the AI provider or model';
          $('model').classList.toggle('problem', !!m.problem);
          break;
        case 'user':
          addUser(m.id, m.html);
          break;
        case 'assistantStart':
          startAssistant(m.id);
          break;
        case 'assistantUpdate': {
          const div = turns.get(m.id);
          if (div) { div.querySelector('.md').innerHTML = m.html; scrollDown(); }
          break;
        }
        case 'progress': {
          const p = turns.get(m.id) && turns.get(m.id).querySelector('.progress-line');
          if (p) p.textContent = m.text;
          break;
        }
        case 'assistantEnd':
          endAssistant(m);
          break;
        case 'busy':
          setBusy(m.value);
          break;
        case 'cleared':
          turns.clear();
          log.innerHTML = '<div class="empty-chat" id="emptyChat"><div class="title">New conversation</div>Ask about health, lag, topics, configs or connection errors.</div>';
          break;
      }
    });
    vscode.postMessage({ command: 'ready' });
    $('input').focus();
  </script>
</body>
</html>`;
  }
}
