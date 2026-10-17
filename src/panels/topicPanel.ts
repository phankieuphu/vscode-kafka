import * as vscode from "vscode";
import { describeError, ClusterManager } from "../kafka/clusterManager";
import { ConfigChanges, describeChanges } from "../kafka/topicConfig";
import { expandTemplate } from "../kafka/templates";
import { exportMessages, kcatProduceCommand, parseBatch } from "../kafka/transfer";
import {
  BrowseRequest,
  ClusterConfig,
  ConsumedMessage,
  MessageFormat,
  ProduceTemplate,
} from "../kafka/types";
import {
  disconnectedBannerCss,
  disconnectedBannerHtml,
  disconnectedBannerScript,
  watchCluster,
} from "./clusterWatch";
import { baseCss, contentSecurityPolicy, createNonce, escapeHtml, icons, scriptValue, sharedScript, sparkleIcon } from "./webview";
import { messageContext, messagesContext } from "../ai/context";
import { isAiReady, onDidChangeAiAvailability } from "../ai/model";
import { openAssistant } from "../ai/open";
import { getAiSettings, updateAiSetting } from "../ai/settings";

type Format = { key: MessageFormat; value: MessageFormat };

type ProduceMessage = {
  command: "produce";
  key: string;
  value: string;
  partition: number | null;
  headers: Record<string, string>;
  valueSubject: string | null;
  count: number;
  delayMs: number;
};

type WebviewInMessage =
  | { command: "ready" }
  | { command: "connect" }
  | { command: "refreshDetails" }
  | { command: "browse"; request: BrowseRequest; mode: "replace" | "older" | "newer" }
  | { command: "cancelBrowse" }
  | { command: "startTail"; format: Format }
  | { command: "stopTail" }
  | { command: "loadConfig" }
  | { command: "saveConfig"; changes: ConfigChanges }
  | { command: "addPartitions" }
  | { command: "copy"; text: string }
  | { command: "copyKcat"; message: ConsumedMessage }
  | { command: "export"; messages: ConsumedMessage[] }
  | { command: "importBatch" }
  | { command: "listSubjects" }
  | { command: "saveTemplate"; template: ProduceTemplate }
  | { command: "deleteTemplate"; name: string }
  | { command: "aiExplainMessage"; message: ConsumedMessage }
  | { command: "aiInferSchema"; messages: ConsumedMessage[] }
  | { command: "aiExplainConfig"; keysSeen?: boolean }
  | ProduceMessage;

const TEMPLATE_KEY = "kafka-manager.templates";

/**
 * One webview panel per (cluster, topic). Reused if already open instead of
 * spawning duplicates.
 */
export class TopicPanel {
  private static readonly panels = new Map<string, TopicPanel>();
  /** Where produce templates are kept (globalState, so they follow the user across workspaces). */
  private static storage: vscode.Memento | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private tailHandle: { stop: () => Promise<void> } | undefined;
  private browseCancel: vscode.CancellationTokenSource | undefined;
  private disposed = false;

  static setStorage(storage: vscode.Memento): void {
    TopicPanel.storage = storage;
  }

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
    private cluster: ClusterConfig,
    private readonly topic: string,
    private readonly key: string
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();

    this.subscriptions.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewInMessage) =>
        this.handleMessage(message).catch((error) =>
          this.post({ command: "status", text: describeError(error), error: true })
        )
      ),
      this.panel.onDidDispose(() => this.dispose()),
      watchCluster(manager, cluster.id, {
        onStatus: (status) => {
          if (status !== "connected") {
            // The manager already stopped the consumer; reflect it in the UI.
            this.tailHandle = undefined;
            this.browseCancel?.cancel();
            this.post({ command: "tailState", running: false });
          }
          this.postConnection();
          if (status === "connected") {
            void this.loadDetails();
          }
        },
        onRemoved: () => this.panel.dispose(),
        onChanged: (updated) => {
          this.cluster = updated;
          this.postConnection();
        },
      }),
      onDidChangeAiAvailability(() => void this.postAi())
    );
  }

  private async postAi(): Promise<void> {
    this.post({ command: "ai", available: await isAiReady() });
  }

  /**
   * Message contents only go to a model with kafka.ai.includeMessagePayloads.
   * Checked here, on the extension side, whatever the webview sends.
   */
  private async allowPayloads(): Promise<boolean> {
    if (getAiSettings().includeMessagePayloads) {
      return true;
    }
    const allow = "Allow Message Contents";
    const choice = await vscode.window.showInformationMessage(
      "Explaining messages sends their keys, headers and values (truncated, with credentials stripped) to the AI model. That is off by default.",
      { modal: true, detail: "This turns on kafka.ai.includeMessagePayloads. Turn it off again in Kafka: AI Setup… or the settings." },
      allow,
    );
    if (choice !== allow) {
      return false;
    }
    await updateAiSetting("includeMessagePayloads", true);
    return true;
  }

  private async handleMessage(message: WebviewInMessage): Promise<void> {
    switch (message.command) {
      case "ready":
        void this.postAi();
        this.postConnection();
        this.postTemplates();
        await this.loadDetails();
        break;
      case "connect":
        try {
          await this.manager.connect(this.cluster);
        } catch (error) {
          this.post({ command: "status", text: `Couldn't connect: ${describeError(error)}`, error: true });
        }
        break;
      case "refreshDetails":
        await this.loadDetails();
        break;
      case "browse":
        await this.browse(message.request, message.mode);
        break;
      case "cancelBrowse":
        this.browseCancel?.cancel();
        break;
      case "startTail":
        await this.startTail(message.format);
        break;
      case "stopTail":
        await this.stopTail();
        break;
      case "loadConfig":
        await this.loadConfig();
        break;
      case "saveConfig":
        await this.saveConfig(message.changes);
        break;
      case "addPartitions":
        await this.addPartitions();
        break;
      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        this.post({ command: "status", text: "Copied to clipboard." });
        break;
      case "copyKcat":
        await vscode.env.clipboard.writeText(kcatProduceCommand(this.cluster, this.topic, message.message));
        this.post({ command: "status", text: "Copied a kcat command that produces this message again." });
        break;
      case "export":
        await this.exportMessages(message.messages);
        break;
      case "importBatch":
        await this.importBatch();
        break;
      case "listSubjects":
        await this.listSubjects();
        break;
      case "saveTemplate":
        await this.saveTemplate(message.template);
        break;
      case "deleteTemplate":
        await this.deleteTemplate(message.name);
        break;
      case "aiExplainMessage": {
        if (!(await this.allowPayloads())) {
          break;
        }
        const m = message.message;
        openAssistant(this.manager, this.cluster.id, {
          task: m.decodeError ? "explain-decode-error" : "explain-message",
          prompt: "",
          label: `${m.decodeError ? "Why can't this message be decoded?" : "Explain this message"} (${this.topic}/${m.partition} @ ${m.offset})`,
          target: { topic: this.topic },
          extraSections: [messageContext(this.topic, m)],
        });
        break;
      }
      case "aiInferSchema": {
        if (message.messages.length === 0) {
          this.post({ command: "status", text: "Load some messages first, then infer their schema.", error: true });
          break;
        }
        if (!(await this.allowPayloads())) {
          break;
        }
        const section = messagesContext(this.topic, message.messages);
        openAssistant(this.manager, this.cluster.id, {
          task: "infer-schema",
          prompt: "",
          label: `Infer the schema of ${this.topic} from ${Math.min(20, message.messages.length)} message(s)`,
          target: { topic: this.topic },
          extraSections: [section],
        });
        break;
      }
      case "aiExplainConfig":
        openAssistant(this.manager, this.cluster.id, {
          task: "topic-config",
          prompt: "",
          label: `Explain the configuration of ${this.topic}`,
          target: { topic: this.topic, keysSeen: message.keysSeen },
        });
        break;
      case "produce":
        await this.produce(message);
        break;
    }
  }

  private postConnection(): void {
    this.panel.title = `Kafka Topic: ${this.topic}`;
    this.post({
      command: "connection",
      status: this.manager.getStatus(this.cluster.id),
      clusterName: this.cluster.name,
      hasRegistry: !!this.cluster.schemaRegistry,
    });
  }

  private async loadDetails(): Promise<void> {
    if (this.manager.getStatus(this.cluster.id) !== "connected") {
      return;
    }
    try {
      const details = await this.manager.getTopicDetails(this.cluster, this.topic);
      this.post({ command: "details", details });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load topic: ${describeError(error)}`, error: true });
      return;
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

  // ---- Topic settings ----------------------------------------------------------

  private async saveConfig(changes: ConfigChanges): Promise<void> {
    if (Object.keys(changes).length === 0) {
      return;
    }
    let current;
    try {
      current = await this.manager.getTopicConfig(this.cluster, this.topic);
    } catch (error) {
      this.post({ command: "configSaved", ok: false });
      this.post({ command: "status", text: `Failed to read settings: ${describeError(error)}`, error: true });
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Change ${Object.keys(changes).length} setting(s) of "${this.topic}" on "${this.cluster.name}"?`,
      { modal: true, detail: describeChanges(current, changes).join("\n") },
      "Save"
    );
    if (confirm !== "Save") {
      this.post({ command: "configSaved", ok: false });
      return;
    }
    try {
      await this.manager.alterTopicConfig(this.cluster, this.topic, changes);
      this.post({ command: "configSaved", ok: true });
      this.post({ command: "status", text: `Saved ${Object.keys(changes).length} setting(s).` });
      await this.loadDetails();
    } catch (error) {
      this.post({ command: "configSaved", ok: false });
      this.post({ command: "status", text: `Failed to save settings: ${describeError(error)}`, error: true });
    }
  }

  private async addPartitions(): Promise<void> {
    let current: number;
    try {
      current = (await this.manager.describeTopic(this.cluster, this.topic)).partitions.length;
    } catch (error) {
      this.post({ command: "status", text: describeError(error), error: true });
      return;
    }
    const input = await vscode.window.showInputBox({
      title: `Add partitions to "${this.topic}"`,
      prompt: `New total partition count (currently ${current}). Partitions can't be removed later.`,
      value: String(current + 1),
      validateInput: (v) =>
        Number.isInteger(Number(v)) && Number(v) > current ? undefined : `Enter a whole number greater than ${current}`,
    });
    if (!input) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Increase "${this.topic}" from ${current} to ${input} partitions?`,
      {
        modal: true,
        detail:
          "Keyed messages will hash to different partitions from now on, so per-key ordering isn't guaranteed across the change. This can't be undone.",
      },
      "Add Partitions"
    );
    if (confirm !== "Add Partitions") {
      return;
    }
    try {
      await this.manager.addPartitions(this.cluster, this.topic, Number(input));
      this.post({ command: "status", text: `"${this.topic}" now has ${input} partitions.` });
      vscode.commands.executeCommand("kafka-manager.refresh");
      await this.loadDetails();
    } catch (error) {
      this.post({ command: "status", text: `Failed to add partitions: ${describeError(error)}`, error: true });
    }
  }

  // ---- Producing ------------------------------------------------------------------

  private async produce(message: ProduceMessage): Promise<void> {
    const count = Math.max(1, Math.min(100_000, Math.trunc(message.count) || 1));
    const delayMs = Math.max(0, Math.trunc(message.delayMs) || 0);
    const build = (seq: number) => {
      const now = new Date();
      const expand = (text: string) => expandTemplate(text, { seq, now });
      return {
        key: expand(message.key),
        value: expand(message.value),
        partition: message.partition ?? undefined,
        headers: Object.fromEntries(Object.entries(message.headers).map(([k, v]) => [k, expand(v)])),
        valueSubject: message.valueSubject ?? undefined,
      };
    };
    try {
      if (count === 1) {
        await this.manager.produce(this.cluster, this.topic, build(1));
      } else {
        const sent = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Sending ${count} messages to "${this.topic}"`, cancellable: true },
          async (progress, token) => {
            let done = 0;
            if (delayMs === 0) {
              const records = Array.from({ length: count }, (_, i) => build(i + 1));
              return this.manager.produceBatch(this.cluster, this.topic, records, (n) => {
                progress.report({ increment: ((n - done) / count) * 100, message: `${n} / ${count}` });
                done = n;
              }, token);
            }
            for (let i = 1; i <= count && !token.isCancellationRequested; i++) {
              await this.manager.produce(this.cluster, this.topic, build(i));
              done = i;
              progress.report({ increment: 100 / count, message: `${i} / ${count}` });
              if (i < count) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
              }
            }
            return done;
          }
        );
        this.post({ command: "status", text: `Sent ${sent} of ${count} messages to "${this.topic}".` });
      }
      this.post({ command: "produced", ok: true });
      if (count === 1) {
        this.post({ command: "status", text: `Sent message to "${this.topic}" at ${new Date().toLocaleTimeString()}.` });
      }
    } catch (error) {
      this.post({ command: "produced", ok: false });
      this.post({ command: "status", text: `Failed to send: ${describeError(error)}`, error: true });
    }
  }

  private async importBatch(): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      title: `Produce messages to "${this.topic}" from a file`,
      canSelectMany: false,
      filters: { "JSON or NDJSON": ["json", "ndjson", "jsonl"], "All files": ["*"] },
    });
    if (!files?.[0]) {
      return;
    }
    let records;
    try {
      records = parseBatch(Buffer.from(await vscode.workspace.fs.readFile(files[0])).toString("utf8"));
    } catch (error) {
      vscode.window.showErrorMessage(`Can't read ${files[0].fsPath}: ${describeError(error)}`);
      return;
    }
    if (records.length === 0) {
      vscode.window.showInformationMessage("The file has no records to send.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Send ${records.length} message(s) to "${this.topic}" on "${this.cluster.name}"?`,
      { modal: true },
      "Send"
    );
    if (confirm !== "Send") {
      return;
    }
    try {
      const sent = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Producing to "${this.topic}"`, cancellable: true },
        (progress, token) => {
          let last = 0;
          return this.manager.produceBatch(this.cluster, this.topic, records, (n) => {
            progress.report({ increment: ((n - last) / records.length) * 100, message: `${n} / ${records.length}` });
            last = n;
          }, token);
        }
      );
      this.post({ command: "status", text: `Sent ${sent} of ${records.length} message(s) from ${files[0].fsPath}.` });
      void this.loadDetails();
    } catch (error) {
      this.post({ command: "status", text: `Batch produce failed: ${describeError(error)}`, error: true });
    }
  }

  private async listSubjects(): Promise<void> {
    try {
      const registry = await this.manager.getSchemaRegistry(this.cluster, true);
      this.post({ command: "subjects", subjects: registry ? await registry.listSubjects() : [] });
    } catch (error) {
      this.post({ command: "subjects", subjects: [] });
      this.post({ command: "status", text: `Couldn't list Schema Registry subjects: ${describeError(error)}`, error: true });
    }
  }

  // ---- Templates ----------------------------------------------------------------------

  private templateKey(): string {
    return `${TEMPLATE_KEY}.${this.cluster.id}.${this.topic}`;
  }

  private templates(): ProduceTemplate[] {
    return TopicPanel.storage?.get<ProduceTemplate[]>(this.templateKey(), []) ?? [];
  }

  private postTemplates(): void {
    this.post({ command: "templates", templates: this.templates() });
  }

  private async saveTemplate(template: ProduceTemplate): Promise<void> {
    if (!TopicPanel.storage) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: `Save produce template for "${this.topic}"`,
      prompt: "Template name. Saving under an existing name replaces it.",
      value: template.name,
      validateInput: (v) => (v.trim() ? undefined : "Enter a name"),
    });
    if (!name) {
      return;
    }
    template = { ...template, name: name.trim() };
    const others = this.templates().filter((t) => t.name !== template.name);
    await TopicPanel.storage.update(this.templateKey(), [...others, template].sort((a, b) => a.name.localeCompare(b.name)));
    this.postTemplates();
    this.post({ command: "status", text: `Saved template "${template.name}".` });
  }

  private async deleteTemplate(name: string): Promise<void> {
    await TopicPanel.storage?.update(this.templateKey(), this.templates().filter((t) => t.name !== name));
    this.postTemplates();
  }

  // ---- Reading ------------------------------------------------------------------------

  private async startTail(format: Format): Promise<void> {
    if (this.tailHandle) {
      await this.stopTail();
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
        },
        format
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

  private async browse(request: BrowseRequest, mode: "replace" | "older" | "newer"): Promise<void> {
    this.browseCancel?.cancel();
    const cancel = new vscode.CancellationTokenSource();
    this.browseCancel = cancel;
    this.post({ command: "loading", value: true, searching: !!request.search });
    try {
      const result = await this.manager.browse(
        this.cluster,
        this.topic,
        request,
        (scanned, matched) => this.post({ command: "browseProgress", scanned, matched, searching: !!request.search }),
        cancel.token
      );
      this.post({ command: "messages", items: result.messages, mode });
      const what = request.search
        ? `Found ${result.messages.length} match(es) for "${request.search}" in ${result.scanned} scanned message(s)`
        : `Loaded ${result.messages.length} message(s)`;
      const why = cancel.token.isCancellationRequested ? " (cancelled)" : result.truncated ? " (stopped at the time limit)" : "";
      this.post({ command: "status", text: `${what}${why} at ${new Date().toLocaleTimeString()}.` });
    } catch (error) {
      this.post({ command: "status", text: `Failed to load messages: ${describeError(error)}`, error: true });
    } finally {
      if (this.browseCancel === cancel) {
        this.browseCancel = undefined;
      }
      cancel.dispose();
      this.post({ command: "loading", value: false });
    }
  }

  private async exportMessages(messages: ConsumedMessage[]): Promise<void> {
    if (messages.length === 0) {
      vscode.window.showInformationMessage("There are no messages to export.");
      return;
    }
    const target = await vscode.window.showSaveDialog({
      title: `Export ${messages.length} message(s) from "${this.topic}"`,
      defaultUri: vscode.Uri.file(`${this.topic}.ndjson`),
      filters: { NDJSON: ["ndjson", "jsonl"], JSON: ["json"] },
    });
    if (!target) {
      return;
    }
    const format = /\.json$/i.test(target.path) ? "json" : "ndjson";
    await vscode.workspace.fs.writeFile(target, Buffer.from(exportMessages(messages, format), "utf8"));
    this.post({ command: "status", text: `Exported ${messages.length} message(s) to ${target.fsPath}.` });
  }

  private post(message: unknown): void {
    if (!this.disposed) {
      this.panel.webview.postMessage(message);
    }
  }

  private dispose(): void {
    this.disposed = true;
    TopicPanel.panels.delete(this.key);
    this.browseCancel?.cancel();
    if (this.tailHandle) {
      this.tailHandle.stop().catch(() => undefined);
    }
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private render(): string {
    const nonce = createNonce();
    const formats = [
      ["auto", "Auto"], ["string", "String"], ["json", "JSON"], ["avro", "Avro"],
      ["protobuf", "Protobuf"], ["json-schema", "JSON Schema"], ["hex", "Hex"], ["base64", "Base64"],
    ].map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}" />
<style>
${baseCss}
${disconnectedBannerCss}
  body { padding: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  header.page { padding: 14px 20px 12px; margin: 0; }
  .view { flex-grow: 1; min-height: 0; overflow: auto; }
  #messagesView { display: flex; overflow: hidden; }
  .list { flex-grow: 1; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
  .list > .toolbar { padding: 8px 20px; border-bottom: 1px solid var(--border); }
  .list .statusline { padding: 6px 20px; display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
  .rows { flex-grow: 1; overflow: auto; }
  .rows table { table-layout: fixed; }
  .rows th { position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
  .rows td { overflow: hidden; text-overflow: ellipsis; }
  .rows th:first-child, .rows td:first-child { padding-left: 20px; }
  .pager { display: flex; justify-content: center; gap: 8px; padding: 8px; }
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
  .three { display: grid; grid-template-columns: minmax(0, 1fr) 80px 90px; gap: 8px; }
  .header-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 26px; gap: 6px; }
  .validity { font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
  .validity.ok { color: var(--good); } .validity.bad { color: var(--vscode-errorForeground); }
  .pad { padding: 14px 20px; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--crit); }
  .config-input { width: 100%; }
  tr.changed td { background: color-mix(in srgb, var(--warn) 12%, transparent); }
  @media (max-width: 900px) { #messagesView { flex-direction: column; overflow: auto; } aside { width: auto; } .list { border-right: none; min-height: 420px; } }
</style>
</head>
<body>
  ${disconnectedBannerHtml()}
  <header class="page">
    <div>
      <div class="title"><h1>${escapeHtml(this.topic)}</h1><span class="sub" id="clusterName">${escapeHtml(this.cluster.name)}</span></div>
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
      <div class="toolbar" data-needs-connection>
        <div class="seg" aria-label="Mode">
          <button aria-pressed="true" id="modeBrowse">Browse</button>
          <button aria-pressed="false" id="modeLive"><span class="live-dot" id="liveDot" hidden></span>Live tail</button>
        </div>
        <span id="browseControls" class="toolbar">
          <label class="inline" for="start">From</label>
          <select id="start">
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="offset">Offset…</option>
            <option value="timestamp">Time…</option>
          </select>
          <label id="offsetWrap" hidden><span class="sr-only">Start offset</span><input type="number" id="startOffset" min="0" step="1" value="0" style="width:110px" /></label>
          <label id="timeWrap" hidden><span class="sr-only">Start time</span><input type="datetime-local" id="startTime" step="1" /></label>
          <label class="inline" for="limit">Per partition</label>
          <select id="limit"><option>20</option><option selected>50</option><option>100</option><option>500</option></select>
          <button id="loadBtn">Load</button>
        </span>
        <button class="secondary" id="pauseBtn" hidden>${icons.pause}Pause</button>
        <label class="inline" for="partitionFilter">Partition</label>
        <select id="partitionFilter"><option value="">All</option></select>
        <label class="inline" for="keyFormat">Key</label>
        <select id="keyFormat" title="How keys are decoded">${formats}</select>
        <label class="inline" for="valueFormat">Value</label>
        <select id="valueFormat" title="How values are decoded">${formats}</select>
      </div>
      <div class="toolbar" style="padding:8px 20px;border-bottom:1px solid var(--border)">
        <label style="display:flex;flex-grow:1;min-width:160px"><span class="sr-only">Filter or search key, value and headers</span><input type="search" id="search" placeholder="Filter loaded messages (key, value, headers)" style="flex-grow:1" /></label>
        <span id="searchControls" class="toolbar" data-needs-connection>
          <button class="secondary" id="searchBtn" title="Scan the topic from the chosen start for messages containing this text">Search topic</button>
          <select id="scanLimit" title="Messages to scan per partition"><option value="1000">scan 1k</option><option value="10000" selected>scan 10k</option><option value="100000">scan 100k</option></select>
        </span>
        <button class="secondary" id="cancelBtn" hidden>Cancel</button>
        <button class="secondary" id="inferSchemaBtn" hidden title="Propose a JSON Schema, Avro schema and produce template from the loaded messages (AI)">${sparkleIcon}Infer schema</button>
        <button class="secondary" id="exportBtn" title="Save the messages shown as JSON or NDJSON">Export…</button>
        <button class="secondary" id="clearBtn">Clear</button>
      </div>
      <div class="statusline sub"><span id="status" role="status">Choose Load to read messages, or switch to Live tail.</span><span id="countNote"></span></div>
      <div class="rows">
        <div class="pager" id="newerPager" hidden data-needs-connection><button class="small secondary" id="newerBtn">Load newer</button></div>
        <table>
          <colgroup><col style="width:64px" /><col style="width:104px" /><col style="width:96px" /><col style="width:150px" /><col /></colgroup>
          <thead><tr><th>Part.</th><th class="num">Offset</th><th>Time</th><th>Key</th><th>Value</th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
        <div class="empty" id="rowsEmpty">No messages loaded yet.</div>
        <div class="pager" id="olderPager" hidden data-needs-connection><button class="small secondary" id="olderBtn">Load older</button></div>
      </div>
    </section>

    <aside>
      <section aria-labelledby="detailTitle">
        <div class="section-head" style="margin:0">
          <h2 id="detailTitle">Message</h2>
          <div class="toolbar" id="detailActions" hidden>
            <button class="icon" id="copyBtn" aria-label="Copy value" title="Copy value">${icons.copy}</button>
            <button class="icon" id="kcatBtn" aria-label="Copy as kcat command" title="Copy as kcat command">$</button>
            <button class="icon" id="resendBtn" aria-label="Load into produce form" title="Load into produce form">${icons.resend}</button>
            <button class="icon" id="aiExplainBtn" hidden aria-label="Explain with AI" title="Explain this message with AI">${sparkleIcon}</button>
          </div>
        </div>
        <div id="detail" class="sub">Select a message to inspect its key, headers and value.</div>
      </section>

      <section aria-labelledby="produceTitle" data-needs-connection>
        <div class="section-head" style="margin:0">
          <h2 id="produceTitle">Produce message</h2>
          <button class="small secondary" id="importBtn" title="Send every record of a JSON array or NDJSON file">From file…</button>
        </div>
        <div class="toolbar">
          <label style="display:flex;flex-grow:1"><span class="sr-only">Template</span><select id="templateSelect" style="flex-grow:1"><option value="">Templates…</option></select></label>
          <button class="small secondary" id="saveTemplateBtn">Save as template</button>
          <button class="icon" id="deleteTemplateBtn" aria-label="Delete template" title="Delete template" disabled>${icons.close}</button>
        </div>
        <div class="two">
          <label class="field">Key (optional)<input type="text" class="mono" id="pKey" /></label>
          <label class="field">Partition<select id="pPartition"><option value="">Auto (by key)</option></select></label>
        </div>
        <label class="field">Value<textarea id="pValue" rows="6" placeholder='{ "id": "{{uuid}}", "at": "{{now}}" }'></textarea></label>
        <label class="field" id="subjectWrap" hidden>Encode value with schema
          <select id="pSubject"><option value="">No — send the text as-is</option></select></label>
        <div id="headers" class="stack" style="gap:6px"></div>
        <div class="sub">Variables: {{uuid}} {{now}} {{nowMs}} {{random.int}} {{seq}}</div>
        <div class="toolbar" style="justify-content:space-between">
          <span class="validity" id="validity"></span>
          <span class="toolbar">
            <button class="secondary" id="addHeader">+ Header</button>
            <label class="inline" title="Send several messages; {{seq}} counts them">×<input type="number" id="pCount" min="1" max="100000" value="1" style="width:64px" /></label>
            <label class="inline" id="delayWrap" hidden title="Pause between messages">every<input type="number" id="pDelay" min="0" value="0" style="width:64px" />ms</label>
            <button id="sendBtn" title="Send (Ctrl/Cmd+Enter)">Send</button>
          </span>
        </div>
      </section>
    </aside>
  </div>

  <div class="view pad" id="partitionsView" role="tabpanel" hidden>
    <div class="card">
      <div class="section-head"><h2>Partitions</h2><button class="small secondary" id="addPartitionsBtn" data-needs-connection>Add partitions…</button></div>
      <div class="scroll" id="partitionsBody"><div class="empty">Loading partitions…</div></div>
    </div>
  </div>

  <div class="view pad" id="configView" role="tabpanel" hidden>
    <div class="card">
      <div class="section-head">
        <h2>Configuration<span class="count" id="configCount"></span></h2>
        <div class="toolbar">
          <button class="small secondary" id="explainConfigBtn" hidden title="Explain non-default and risky settings with AI">${sparkleIcon}Explain config</button>
          <label class="inline"><input type="checkbox" id="showDefaults" /> Show defaults</label>
          <label><span class="sr-only">Filter configuration</span><input type="search" id="configFilter" placeholder="Filter settings" /></label>
          <span class="toolbar" id="configActions" hidden data-needs-connection>
            <button class="small secondary" id="discardConfigBtn">Discard</button>
            <button class="small" id="saveConfigBtn">Save changes</button>
          </span>
        </div>
      </div>
      <div class="scroll" id="configBody"><div class="empty">Loading configuration…</div></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
${sharedScript}
${disconnectedBannerScript}
    const MAX_ROWS = 5000;
    const state = {
      details: null, config: null, messages: [], selected: null, live: false, tailing: false, since: '', received: 0, tailStart: 0,
      lastRequest: null, configEdits: {}, templates: [], connection: 'disconnected', clusterName: ${scriptValue(this.cluster.name)}, hasRegistry: false, subjectsLoaded: false,
    };

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
      const edits = state.configEdits;
      const editCount = Object.keys(edits).length;
      $('configActions').hidden = editCount === 0;
      $('saveConfigBtn').textContent = 'Save ' + editCount + ' change' + (editCount === 1 ? '' : 's') + '…';
      const q = $('configFilter').value.trim().toLowerCase();
      const all = $('showDefaults').checked;
      const list = state.config.filter((e) => (all || !e.isDefault || e.name in edits) && (!q || e.name.includes(q) || String(e.value).toLowerCase().includes(q)));
      const overrides = state.config.filter((e) => !e.isDefault).length;
      $('configCount').textContent = overrides + ' overridden · ' + state.config.length + ' total';
      if (!list.length) {
        $('configBody').innerHTML = '<div class="empty">' + (all || q ? 'No settings match.' : 'Every setting uses the broker default. Tick “Show defaults” to see and change them.') + '</div>';
        return;
      }
      $('configBody').innerHTML = '<table><thead><tr><th>Setting</th><th style="width:40%">Value</th><th>Source</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>' +
        list.map((e) => {
          const edited = e.name in edits;
          const value = edited ? (edits[e.name] === null ? '' : edits[e.name]) : e.value;
          const valueCell = e.readOnly || e.isSensitive
            ? '<td class="mono">' + esc(e.value) + '</td>'
            : '<td><label><span class="sr-only">' + esc(e.name) + '</span><input type="text" class="mono config-input" data-config="' + esc(e.name) + '" value="' + esc(value ?? '') + '"' +
              (edited && edits[e.name] === null ? ' placeholder="default"' : '') + ' /></label></td>';
          const source = edited ? '<span class="chip">' + (edits[e.name] === null ? 'reset to default' : 'edited') + '</span>'
            : e.isTopicOverride ? '<span class="chip">topic override</span>' : e.isDefault ? '<span class="muted">default</span>' : '<span class="muted">broker</span>';
          const action = !e.readOnly && (e.isTopicOverride || edited)
            ? '<button class="small secondary" data-reset="' + esc(e.name) + '">' + (edited ? 'Undo' : 'Reset to default') + '</button>' : '';
          return '<tr' + (edited ? ' class="changed"' : '') + '><td class="mono">' + esc(e.name) + '</td>' + valueCell + '<td>' + source +
            (e.readOnly ? ' <span class="muted">read-only</span>' : '') + '</td><td>' + action + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    // ---- Messages -------------------------------------------------------------

    function visibleMessages() {
      const partition = $('partitionFilter').value;
      const q = $('search').value.trim().toLowerCase();
      return state.messages.filter((m) =>
        (partition === '' || String(m.partition) === partition) &&
        (!q || String(m.key ?? '').toLowerCase().includes(q) || String(m.value ?? '').toLowerCase().includes(q) ||
          Object.values(m.headers || {}).some((v) => String(v).toLowerCase().includes(q))));
    }

    function msgId(m) { return m.partition + ':' + m.offset; }

    function renderRows() {
      const list = visibleMessages();
      $('rows').innerHTML = list.map((m) => '<tr class="link' + (state.selected === msgId(m) ? ' selected' : '') + '" tabindex="0" data-id="' + esc(msgId(m)) + '">' +
        '<td>' + m.partition + '</td>' +
        '<td class="num">' + fmtBig(m.offset) + '</td>' +
        '<td class="muted" title="' + esc(fmtDateTime(m.timestamp)) + '">' + esc(fmtTime(m.timestamp)) + '</td>' +
        '<td class="mono key">' + esc(m.key == null ? 'null' : m.key) + '</td>' +
        '<td class="mono"' + (m.decodeError ? ' title="' + esc(m.decodeError) + '"' : '') + '>' + (m.decodeError ? '⚠ ' : '') + esc(oneLine(m.value)) + '</td></tr>').join('');
      const empty = $('rowsEmpty');
      empty.hidden = list.length > 0;
      empty.innerHTML = state.messages.length
        ? 'No messages match the filters. <button class="small secondary" id="clearFilters">Clear filters</button>'
        : state.live ? 'Waiting for new messages…' : 'No messages loaded yet.';
      $('countNote').textContent = state.messages.length
        ? (list.length !== state.messages.length ? list.length + ' of ' : '') + state.messages.length + ' shown · newest first'
        : '';
      const pageable = !state.live && state.messages.length > 0 && state.lastRequest && !state.lastRequest.search;
      $('olderPager').hidden = !pageable;
      $('newerPager').hidden = !pageable;
    }

    function renderDetail() {
      const m = state.messages.find((x) => msgId(x) === state.selected);
      $('detailActions').hidden = !m;
      if (m) {
        const label = m.decodeError ? 'Explain the decode error with AI' : 'Explain this message with AI';
        $('aiExplainBtn').title = label;
        $('aiExplainBtn').setAttribute('aria-label', label);
      }
      if (!m) {
        $('detailTitle').textContent = 'Message';
        $('detail').className = 'sub';
        $('detail').textContent = 'Select a message to inspect its key, headers and value.';
        return;
      }
      $('detailTitle').textContent = 'Message · partition ' + m.partition + ' · offset ' + fmtBig(m.offset);
      const headers = Object.entries(m.headers || {});
      const pretty = m.value == null ? null : highlightJson(m.value);
      const schema = (s) => s ? 'schema ' + s.id + (s.subject ? ' · ' + s.subject : '') + (s.type !== 'UNKNOWN' ? ' · ' + s.type : '') : '';
      $('detail').className = 'stack';
      $('detail').style.gap = '10px';
      $('detail').innerHTML = '<div class="kv">' +
        '<span>Key</span><span class="mono key" style="color:var(--vscode-debugTokenExpression-name)">' + esc(m.key == null ? 'null' : m.key) +
          (m.keyEncoding && m.keyEncoding !== 'utf-8' && m.keyEncoding !== 'null' ? ' <span class="muted">(' + esc(m.keyEncoding) + (m.keySchema ? ', ' + esc(schema(m.keySchema)) : '') + ')</span>' : '') + '</span>' +
        '<span>Time</span><span>' + esc(fmtDateTime(m.timestamp)) + '</span>' +
        '<span>Headers</span><span class="mono">' + (headers.length ? headers.map(([k, v]) => esc(k + '=' + v)).join(' · ') : '<span class="muted">none</span>') + '</span>' +
        '<span>Format</span><span>' + esc(m.valueEncoding || 'utf-8') + (m.valueSchema ? ' · ' + esc(schema(m.valueSchema)) : '') + '</span>' +
        '<span>Size</span><span>' + fmt.format(m.size ?? new TextEncoder().encode(m.value || '').length) + ' bytes</span></div>' +
        (m.decodeError ? '<div class="alert warn">' + esc(m.decodeError) + '</div>' : '') +
        '<pre class="value">' + (pretty ?? (m.value == null ? '<span class="muted">null</span>' : esc(m.value))) + '</pre>';
    }

    function updateStatusLine() {
      if (!state.tailing) return;
      const secs = Math.max(1, (Date.now() - state.tailStart) / 1000);
      $('status').textContent = 'Tailing since ' + state.since + ' · ' + fmt.format(state.received) + ' received · ~' + (state.received / secs).toFixed(1) + ' msg/s';
      $('status').classList.remove('error');
    }

    function currentFormat() { return { key: $('keyFormat').value, value: $('valueFormat').value }; }

    function setMode(live) {
      state.live = live;
      $('modeBrowse').setAttribute('aria-pressed', String(!live));
      $('modeLive').setAttribute('aria-pressed', String(live));
      $('browseControls').hidden = live;
      $('searchControls').hidden = live;
      $('pauseBtn').hidden = !live;
      if (live) {
        vscode.postMessage({ command: 'startTail', format: currentFormat() });
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

    function startPosition() {
      const kind = $('start').value;
      if (kind === 'offset') return { kind, offset: String(Math.max(0, Math.trunc(Number($('startOffset').value) || 0))) };
      if (kind === 'timestamp') {
        const t = new Date($('startTime').value).getTime();
        return isNaN(t) ? null : { kind, timestamp: t };
      }
      return { kind };
    }

    function baseRequest(position) {
      const partition = $('partitionFilter').value;
      return { position, limit: Number($('limit').value), format: currentFormat(), ...(partition === '' ? {} : { partition: Number(partition) }) };
    }

    function load() {
      const position = startPosition();
      if (!position) { $('status').textContent = 'Pick a start time.'; $('status').classList.add('error'); return; }
      state.lastRequest = baseRequest(position);
      vscode.postMessage({ command: 'browse', request: state.lastRequest, mode: 'replace' });
    }

    function searchTopic() {
      const q = $('search').value.trim();
      if (!q) { $('status').textContent = 'Type the text to search for first.'; $('status').classList.add('error'); $('search').focus(); return; }
      const position = startPosition();
      if (!position) { $('status').textContent = 'Pick a start time.'; $('status').classList.add('error'); return; }
      state.lastRequest = { ...baseRequest(position), search: q, scanLimit: Number($('scanLimit').value) };
      vscode.postMessage({ command: 'browse', request: state.lastRequest, mode: 'replace' });
    }

    /** The lowest (older) or highest (newer) offset loaded per partition. */
    function edges(older) {
      const result = {};
      for (const m of state.messages) {
        const cur = result[m.partition];
        if (cur === undefined || (older ? big(m.offset) < big(cur) : big(m.offset) > big(cur))) result[m.partition] = m.offset;
      }
      return result;
    }

    function page(older) {
      const offsets = edges(older);
      if (!Object.keys(offsets).length) return;
      const request = { ...baseRequest({ kind: older ? 'before' : 'after', offsets }), format: currentFormat() };
      vscode.postMessage({ command: 'browse', request, mode: older ? 'older' : 'newer' });
    }

    function sortMessages() {
      state.messages.sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || b.partition - a.partition || cmpBig(b.offset, a.offset));
    }

    function addMessages(items, mode) {
      if (mode === 'replace') {
        state.messages = items.slice();
      } else {
        const seen = new Set(state.messages.map(msgId));
        const fresh = items.filter((m) => !seen.has(msgId(m)));
        state.messages = mode === 'prepend' ? fresh.concat(state.messages) : state.messages.concat(fresh);
        if (mode === 'prepend') state.received += fresh.length;
      }
      if (mode !== 'prepend') sortMessages();
      if (state.messages.length > MAX_ROWS) {
        // Paging older drops the newest; everything else drops the oldest.
        state.messages = mode === 'older' ? state.messages.slice(-MAX_ROWS) : state.messages.slice(0, MAX_ROWS);
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
      // Variables are replaced before sending; check the JSON with placeholders filled in.
      const probe = text.replace(/\\{\\{\\s*[\\w.]+\\s*\\}\\}/g, '0');
      try {
        JSON.parse(probe);
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
      vscode.postMessage({
        command: 'produce', key: $('pKey').value, value, partition: partition === '' ? null : Number(partition), headers: readHeaders(),
        valueSubject: $('pSubject').value || null, count: Number($('pCount').value) || 1, delayMs: Number($('pDelay').value) || 0,
      });
    }

    function renderTemplates() {
      const current = $('templateSelect').value;
      $('templateSelect').innerHTML = '<option value="">' + (state.templates.length ? 'Templates (' + state.templates.length + ')…' : 'No saved templates') + '</option>' +
        state.templates.map((t) => '<option>' + esc(t.name) + '</option>').join('');
      $('templateSelect').value = state.templates.some((t) => t.name === current) ? current : '';
      $('deleteTemplateBtn').disabled = !$('templateSelect').value;
    }

    function applyTemplate(t) {
      $('pKey').value = t.key || '';
      $('pValue').value = t.value || '';
      $('pPartition').value = t.partition == null ? '' : String(t.partition);
      $('headers').innerHTML = '';
      for (const [k, v] of Object.entries(t.headers || {})) addHeaderRow(k, v);
      if (t.valueSubject && state.hasRegistry) {
        if (![...$('pSubject').options].some((o) => o.value === t.valueSubject)) $('pSubject').insertAdjacentHTML('beforeend', '<option>' + esc(t.valueSubject) + '</option>');
        $('pSubject').value = t.valueSubject;
      } else {
        $('pSubject').value = '';
      }
      updateValidity();
    }

    // ---- Wiring -----------------------------------------------------------------

    document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      document.querySelectorAll('[role=tabpanel]').forEach((p) => { p.hidden = p.id !== tab.dataset.tab; });
      if (tab.dataset.tab === 'configView' && !state.config) vscode.postMessage({ command: 'loadConfig' });
    }));

    $('modeBrowse').addEventListener('click', () => state.live && setMode(false));
    $('modeLive').addEventListener('click', () => !state.live && setMode(true));
    $('pauseBtn').addEventListener('click', () => vscode.postMessage(state.tailing ? { command: 'stopTail' } : { command: 'startTail', format: currentFormat() }));
    $('start').addEventListener('change', () => {
      $('offsetWrap').hidden = $('start').value !== 'offset';
      $('timeWrap').hidden = $('start').value !== 'timestamp';
    });
    $('loadBtn').addEventListener('click', load);
    $('searchBtn').addEventListener('click', searchTopic);
    $('search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !state.live) searchTopic(); });
    $('cancelBtn').addEventListener('click', () => vscode.postMessage({ command: 'cancelBrowse' }));
    $('olderBtn').addEventListener('click', () => page(true));
    $('newerBtn').addEventListener('click', () => page(false));
    for (const id of ['keyFormat', 'valueFormat']) {
      $(id).addEventListener('change', () => {
        vscode.setState({ ...(vscode.getState() || {}), format: currentFormat() });
        // Re-read with the new format so what's shown matches the picker.
        if (state.live && state.tailing) vscode.postMessage({ command: 'startTail', format: currentFormat() });
        else if (!state.live && state.lastRequest) {
          state.lastRequest = { ...state.lastRequest, format: currentFormat() };
          vscode.postMessage({ command: 'browse', request: state.lastRequest, mode: 'replace' });
        }
      });
    }
    $('exportBtn').addEventListener('click', () => vscode.postMessage({ command: 'export', messages: visibleMessages() }));
    $('clearBtn').addEventListener('click', () => { state.messages = []; state.selected = null; state.lastRequest = null; renderRows(); renderDetail(); });
    $('partitionFilter').addEventListener('change', renderRows);
    $('search').addEventListener('input', renderRows);
    $('configFilter').addEventListener('input', () => renderConfig());
    $('showDefaults').addEventListener('change', () => renderConfig());
    $('configBody').addEventListener('change', (e) => {
      const input = e.target.closest('[data-config]');
      if (!input) return;
      const name = input.dataset.config;
      const entry = state.config.find((x) => x.name === name);
      if (input.value === (entry.value ?? '') && !(name in state.configEdits && state.configEdits[name] === null)) delete state.configEdits[name];
      else state.configEdits[name] = input.value;
      renderConfig();
    });
    $('configBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-reset]');
      if (!btn) return;
      const name = btn.dataset.reset;
      if (name in state.configEdits) delete state.configEdits[name];
      else state.configEdits[name] = null;
      renderConfig();
    });
    $('discardConfigBtn').addEventListener('click', () => { state.configEdits = {}; renderConfig(); });
    $('saveConfigBtn').addEventListener('click', () => {
      $('saveConfigBtn').disabled = true;
      vscode.postMessage({ command: 'saveConfig', changes: state.configEdits });
    });
    $('addPartitionsBtn').addEventListener('click', () => vscode.postMessage({ command: 'addPartitions' }));
    $('pValue').addEventListener('input', updateValidity);
    $('addHeader').addEventListener('click', () => addHeaderRow());
    $('pCount').addEventListener('input', () => { $('delayWrap').hidden = !(Number($('pCount').value) > 1); });
    $('sendBtn').addEventListener('click', send);
    $('importBtn').addEventListener('click', () => vscode.postMessage({ command: 'importBatch' }));
    $('pValue').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
    $('pSubject').addEventListener('focus', () => {
      if (!state.subjectsLoaded) { state.subjectsLoaded = true; vscode.postMessage({ command: 'listSubjects' }); }
    });
    $('templateSelect').addEventListener('change', () => {
      const t = state.templates.find((x) => x.name === $('templateSelect').value);
      $('deleteTemplateBtn').disabled = !t;
      if (t) applyTemplate(t);
    });
    $('saveTemplateBtn').addEventListener('click', () => {
      const name = $('templateSelect').value;
      const partition = $('pPartition').value;
      vscode.postMessage({ command: 'saveTemplate', template: {
        name, key: $('pKey').value, value: $('pValue').value, headers: readHeaders(),
        partition: partition === '' ? null : Number(partition), ...($('pSubject').value ? { valueSubject: $('pSubject').value } : {}),
      } });
    });
    $('deleteTemplateBtn').addEventListener('click', () => {
      const name = $('templateSelect').value;
      if (name) vscode.postMessage({ command: 'deleteTemplate', name });
    });
    const selectedMessage = () => state.messages.find((x) => msgId(x) === state.selected);
    $('copyBtn').addEventListener('click', () => {
      const m = selectedMessage();
      if (m) vscode.postMessage({ command: 'copy', text: m.value ?? '' });
    });
    $('aiExplainBtn').addEventListener('click', () => {
      const m = selectedMessage();
      if (m) vscode.postMessage({ command: 'aiExplainMessage', message: m });
    });
    $('inferSchemaBtn').addEventListener('click', () => vscode.postMessage({ command: 'aiInferSchema', messages: visibleMessages().slice(0, 200) }));
    $('explainConfigBtn').addEventListener('click', () => {
      // Whether loaded messages have keys matters for compacted topics; unknown when none are loaded.
      const loaded = state.messages;
      vscode.postMessage({ command: 'aiExplainConfig', keysSeen: loaded.length ? loaded.some((m) => m.key != null && m.key !== '') : undefined });
    });
    $('kcatBtn').addEventListener('click', () => {
      const m = selectedMessage();
      if (m) vscode.postMessage({ command: 'copyKcat', message: m });
    });
    $('resendBtn').addEventListener('click', () => {
      const m = selectedMessage();
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

    const saved = vscode.getState() || {};
    if (saved.format) { $('keyFormat').value = saved.format.key; $('valueFormat').value = saved.format.value; }

    setInterval(updateStatusLine, 1000);

    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.command) {
        case 'connection':
          state.connection = message.status;
          state.clusterName = message.clusterName;
          state.hasRegistry = message.hasRegistry;
          $('clusterName').textContent = message.clusterName;
          $('subjectWrap').hidden = !message.hasRegistry;
          renderConnection(message.status, message.clusterName);
          break;
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
        case 'configSaved':
          $('saveConfigBtn').disabled = false;
          if (message.ok) { state.configEdits = {}; renderConfig(); }
          break;
        case 'messages':
          addMessages(message.items, message.mode);
          renderRows();
          if (message.mode === 'replace') renderDetail();
          break;
        case 'browseProgress':
          if (message.searching) $('status').textContent = 'Searching… ' + fmt.format(message.scanned) + ' scanned · ' + fmt.format(message.matched) + ' found';
          else $('status').textContent = 'Loading… ' + fmt.format(message.scanned) + ' read';
          $('status').classList.remove('error');
          break;
        case 'tailState':
          setTailing(message.running, message.since);
          break;
        case 'loading':
          $('progress').classList.toggle('active', message.value);
          $('loadBtn').disabled = message.value;
          $('searchBtn').disabled = message.value;
          $('cancelBtn').hidden = !message.value;
          break;
        case 'produced':
          $('sendBtn').disabled = false;
          if (message.ok) {
            if (!$('templateSelect').value) { $('pValue').value = ''; updateValidity(); }
            vscode.postMessage({ command: 'refreshDetails' });
          }
          break;
        case 'templates':
          state.templates = message.templates;
          renderTemplates();
          break;
        case 'subjects': {
          const current = $('pSubject').value;
          $('pSubject').innerHTML = '<option value="">No — send the text as-is</option>' + message.subjects.map((s) => '<option>' + esc(s) + '</option>').join('');
          $('pSubject').value = message.subjects.includes(current) ? current : '';
          break;
        }
        case 'status':
          $('status').textContent = message.text;
          $('status').classList.toggle('error', !!message.error);
          break;
        case 'ai':
          $('aiExplainBtn').hidden = !message.available;
          $('inferSchemaBtn').hidden = !message.available;
          $('explainConfigBtn').hidden = !message.available;
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
