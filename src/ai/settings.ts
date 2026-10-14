import * as vscode from "vscode";

const SECTION = "kafka.ai";
/** `when`-clause key: true while AI features may be shown (enabled and the workspace is trusted). */
export const AI_CONTEXT_KEY = "kafka-manager.aiEnabled";
const CONSENT_KEY = "kafka-manager.aiConsent";

export interface AiSettings {
  enabled: boolean;
  /** Preferred chat model family, e.g. "gpt-4o"; any available model when omitted. */
  modelFamily?: string;
  /** Message keys and values are only sent to the model when this is set. */
  includeMessagePayloads: boolean;
  /** Replace broker and Schema Registry hostnames with placeholders. */
  maskHosts: boolean;
}

export type AiSettingKey = "enabled" | "modelFamily" | "includeMessagePayloads" | "maskHosts";

/** Writes a `kafka.ai.*` setting where it is currently defined: the workspace if set there, else user settings. */
export async function updateAiSetting(key: AiSettingKey, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const inspected = config.inspect(key);
  const target =
    inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}

export function getAiSettings(): AiSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const family = config.get<string>("modelFamily", "").trim();
  return {
    enabled: config.get<boolean>("enabled", true),
    modelFamily: family || undefined,
    includeMessagePayloads: config.get<boolean>("includeMessagePayloads", false),
    maskHosts: config.get<boolean>("maskHosts", false),
  };
}

/** AI is off in untrusted workspaces, for the same reason workspace clusters are ignored there. */
export function isAiAvailable(): boolean {
  return vscode.workspace.isTrusted && getAiSettings().enabled;
}

/** Keeps {@link AI_CONTEXT_KEY} in step with the settings and workspace trust. */
export function registerAiContext(): vscode.Disposable {
  const update = () => vscode.commands.executeCommand("setContext", AI_CONTEXT_KEY, isAiAvailable());
  void update();
  return vscode.Disposable.from(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        void update();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void update()),
  );
}

export function hasAiConsent(state: vscode.Memento): boolean {
  return state.get<boolean>(CONSENT_KEY) === true;
}

/**
 * Shows, once (or again with `review`), what is sent to the chat model and
 * where. Resolves true when the user has accepted it (now or before).
 */
export async function ensureAiConsent(state: vscode.Memento, review = false): Promise<boolean> {
  if (hasAiConsent(state) && !review) {
    return true;
  }
  const settings = getAiSettings();
  const detail = [
    "Kafka Manager AI features send context to the chat model you use in VS Code (for example GitHub Copilot), under that provider's terms.",
    "",
    "Sent: cluster, topic and consumer group names, configs, lag figures and error messages.",
    "Never sent: passwords, SASL usernames, AWS keys, certificate and key paths.",
    settings.includeMessagePayloads
      ? "Message keys and values: sent (kafka.ai.includeMessagePayloads is on), truncated."
      : "Message keys and values: not sent unless you turn on kafka.ai.includeMessagePayloads.",
    settings.maskHosts
      ? "Broker hostnames: masked."
      : "Broker hostnames: sent as-is; turn on kafka.ai.maskHosts to mask them.",
    "",
    "Turn all AI features off with kafka.ai.enabled.",
  ].join("\n");
  const choice = await vscode.window.showInformationMessage(
    "Use AI features with your Kafka data?",
    { modal: true, detail },
    "Continue",
    "Open Settings",
  );
  if (choice === "Open Settings") {
    void vscode.commands.executeCommand("workbench.action.openSettings", SECTION);
    return hasAiConsent(state);
  }
  if (choice !== "Continue") {
    return hasAiConsent(state);
  }
  await state.update(CONSENT_KEY, true);
  return true;
}
