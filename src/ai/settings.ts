import * as vscode from "vscode";

const SECTION = "kafka.ai";
/** `when`-clause key: true while AI features may be shown (enabled and the workspace is trusted). */
export const AI_CONTEXT_KEY = "kafka-manager.aiEnabled";
const CONSENT_KEY = "kafka-manager.aiConsent";

export type ChatLocation = "panel" | "chatView";

export interface AiSettings {
  enabled: boolean;
  /** A provider id from the catalog, or "auto". */
  provider: string;
  /** Model id for the provider; the provider's recommended model when omitted. */
  model?: string;
  /** Endpoint override for the provider (Azure, gateways, Ollama on another port). */
  baseUrl?: string;
  maxOutputTokens: number;
  /** Message keys and values are only sent to the model when this is set. */
  includeMessagePayloads: boolean;
  /** Replace broker and Schema Registry hostnames with placeholders. */
  maskHosts: boolean;
  /** Where "Ask AI" opens. */
  chatLocation: ChatLocation;
  /** Ask the model for a one-line cause when a lag alert fires. */
  autoAnalyzeLagAlerts: boolean;
}

export type AiSettingKey =
  | "enabled"
  | "provider"
  | "model"
  | "baseUrl"
  | "includeMessagePayloads"
  | "maskHosts"
  | "chatLocation"
  | "autoAnalyzeLagAlerts";

/** Settings that only user settings may hold (`"scope": "application"`), so a workspace can't redirect your API key. */
const USER_ONLY: ReadonlySet<AiSettingKey> = new Set(["provider", "baseUrl"]);

/** Writes a `kafka.ai.*` setting where it is currently defined: the workspace if set there, else user settings. */
export async function updateAiSetting(key: AiSettingKey, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const inspected = config.inspect(key);
  const target = USER_ONLY.has(key)
    ? vscode.ConfigurationTarget.Global
    : inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await config.update(key, value === "" ? undefined : value, target);
}

export function getAiSettings(): AiSettings {
  const config = vscode.workspace.getConfiguration(SECTION);
  const text = (key: string) => config.get<string>(key, "").trim() || undefined;
  // Read user-only settings from user settings even if an older VS Code merged in a workspace value.
  const userText = (key: string) => {
    const value = config.inspect<string>(key)?.globalValue;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const location = config.get<string>("chatLocation", "panel");
  return {
    enabled: config.get<boolean>("enabled", true),
    provider: userText("provider") ?? "auto",
    model: text("model"),
    baseUrl: userText("baseUrl"),
    maxOutputTokens: Math.max(256, Math.min(32_000, config.get<number>("maxOutputTokens", 2048) || 2048)),
    includeMessagePayloads: config.get<boolean>("includeMessagePayloads", false),
    maskHosts: config.get<boolean>("maskHosts", false),
    chatLocation: location === "chatView" ? "chatView" : "panel",
    autoAnalyzeLagAlerts: config.get<boolean>("autoAnalyzeLagAlerts", false),
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

/** Where data goes, for the notice: the provider and its host. */
export interface AiDestination {
  /** Consent is remembered per destination; switching provider asks again. */
  id: string;
  label: string;
  /** e.g. "api.anthropic.com", or "this machine". */
  where: string;
  local?: boolean;
}

function consentKey(destination: AiDestination): string {
  return `${CONSENT_KEY}.${destination.id}`;
}

export function hasAiConsent(state: vscode.Memento, destination?: AiDestination): boolean {
  if (!destination) {
    return state.keys().some((k) => k.startsWith(`${CONSENT_KEY}.`) && state.get(k) === true);
  }
  return state.get<boolean>(consentKey(destination)) === true;
}

/** The text of the data notice. Pure, for tests. */
export function consentDetail(settings: AiSettings, destination: AiDestination): string {
  return [
    destination.local
      ? `Kafka Manager AI features send context to ${destination.label} running on ${destination.where}. Nothing leaves this machine.`
      : `Kafka Manager AI features send context to ${destination.label} (${destination.where}), under that provider's terms.`,
    "",
    "Sent: cluster, topic and consumer group names, configs, lag figures and error messages.",
    "Never sent: passwords, SASL usernames, API keys, AWS keys, certificate and key paths.",
    settings.includeMessagePayloads
      ? "Message keys and values: sent when you ask about messages (kafka.ai.includeMessagePayloads is on), truncated."
      : "Message keys and values: not sent unless you turn on kafka.ai.includeMessagePayloads.",
    settings.maskHosts
      ? "Broker hostnames: masked."
      : "Broker hostnames: sent as-is; turn on kafka.ai.maskHosts to mask them.",
    "",
    "AI never changes your cluster. Turn all AI features off with kafka.ai.enabled.",
  ].join("\n");
}

/**
 * Shows, once per destination (or again with `review`), what is sent to the
 * model and where. Resolves true when the user has accepted it.
 */
export async function ensureAiConsent(state: vscode.Memento, destination: AiDestination, review = false): Promise<boolean> {
  if (hasAiConsent(state, destination) && !review) {
    return true;
  }
  const choice = await vscode.window.showInformationMessage(
    `Send Kafka context to ${destination.label}?`,
    { modal: true, detail: consentDetail(getAiSettings(), destination) },
    "Continue",
    "Open Settings",
  );
  if (choice === "Open Settings") {
    void vscode.commands.executeCommand("workbench.action.openSettings", SECTION);
    return hasAiConsent(state, destination);
  }
  if (choice !== "Continue") {
    return hasAiConsent(state, destination);
  }
  await state.update(consentKey(destination), true);
  return true;
}
