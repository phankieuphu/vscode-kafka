import * as vscode from "vscode";
import { deleteKey, maskKey, resolveKey, signInToOpenRouter, storeKey } from "./keys";
import { clearModelCache, getModelChoices, prepareModel, resolveProvider, selectModel } from "./model";
import { getProvider, keyMismatch, PROVIDERS, ProviderInfo, validateBaseUrl } from "./providers/catalog";
import { listHttpModels } from "./providers/httpModel";
import { AiProviderError, NEVER_CANCELLED, userText } from "./providers/types";
import { AiSettings, ensureAiConsent, getAiSettings, hasAiConsent, updateAiSetting } from "./settings";
import { aiOutputChannel, channelOutput, streamModelResponse } from "./stream";

const SETUP_TITLE = "Kafka AI Setup";
const OPEN_SETUP = "AI Setup";

type SetupAction =
  | "trust"
  | "toggleEnabled"
  | "pickProvider"
  | "credentials"
  | "removeKey"
  | "baseUrl"
  | "pickModel"
  | "togglePayloads"
  | "toggleMaskHosts"
  | "reviewNotice"
  | "chatLocation"
  | "chat"
  | "test"
  | "showOutput"
  | "openSettings";

export interface SetupItem extends vscode.QuickPickItem {
  action?: SetupAction;
}

/** How the current provider is signed in, for the picker. */
export type CredentialState =
  | { kind: "stored"; masked: string }
  | { kind: "env"; envVar: string }
  | { kind: "missing" }
  | { kind: "notNeeded" }
  | { kind: "vscode" };

/** What the setup picker shows. `model` is the resolved model name, or why none is usable; undefined while loading. */
export interface SetupState {
  trusted: boolean;
  settings: AiSettings;
  consented: boolean;
  /** The provider in use ("auto" resolved), when known. */
  provider?: ProviderInfo;
  credential?: CredentialState;
  model?: { name: string } | { problem: string };
}

const separator = (label: string): SetupItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

function credentialRow(provider: ProviderInfo, credential: CredentialState | undefined): SetupItem {
  const oauth = provider.auth === "apiKeyOrOAuth";
  switch (credential?.kind) {
    case "stored":
      return {
        label: "$(key) API key",
        description: `${credential.masked} · in your OS keychain`,
        detail: oauth ? "Select to sign in again or paste another key" : "Select to replace it",
        action: "credentials",
      };
    case "env":
      return {
        label: "$(key) API key",
        description: `from $${credential.envVar}`,
        detail: "Select to store a key in VS Code instead",
        action: "credentials",
      };
    case "notNeeded":
      return { label: "$(key) API key", description: "Not needed", detail: "Select to add one if your server requires it", action: "credentials" };
    case "vscode":
      return { label: "$(account) Sign-in", description: "Handled by VS Code", detail: "Sign in to GitHub Copilot or your chat model extension in VS Code's Accounts menu", action: "credentials" };
    default:
      return {
        label: oauth ? "$(warning) Not signed in" : "$(warning) No API key",
        description: oauth ? "Sign in with your browser, or paste a key" : "Required",
        detail: oauth ? "Select to sign in to OpenRouter" : `Select to add your ${provider.label} API key${provider.keyUrl ? ` (get one at ${provider.keyUrl})` : ""}`,
        action: "credentials",
      };
  }
}

/** The rows of the setup picker for `state`. */
export function setupItems(state: SetupState): SetupItem[] {
  const { settings } = state;
  const items: SetupItem[] = [separator("Status")];
  if (!state.trusted) {
    items.push({
      label: "$(shield) Disabled in this untrusted workspace",
      detail: "AI features never run in untrusted workspaces. Select to manage workspace trust.",
      action: "trust",
    });
  }
  items.push({
    label: "$(sparkle) AI features",
    description: settings.enabled ? "On" : "Off",
    detail: settings.enabled ? "Select to turn every AI feature off" : "Select to turn AI features on",
    action: "toggleEnabled",
  });
  const usable = state.trusted && settings.enabled;
  if (usable) {
    const provider = state.provider;
    items.push(separator("Provider"));
    items.push({
      label: "$(server-environment) Provider",
      description: provider ? `${provider.label}${settings.provider === "auto" ? " (auto)" : ""}` : settings.provider === "auto" ? "Auto: none set up yet" : settings.provider,
      detail: "Claude, GPT, Gemini, OpenRouter, Mistral, Groq, DeepSeek, xAI, Azure OpenAI, Ollama, LM Studio, custom, or VS Code (Copilot). Select to change.",
      action: "pickProvider",
    });
    if (provider) {
      items.push(credentialRow(provider, state.credential));
      if (state.credential?.kind === "stored") {
        items.push({ label: "$(trash) Remove stored key", description: provider.label, action: "removeKey" });
      }
      if (provider.needsBaseUrl || provider.kind !== "vscode") {
        items.push({
          label: "$(globe) Endpoint",
          description: settings.baseUrl ?? (provider.baseUrl || "Not set"),
          detail: provider.needsBaseUrl ? "Required for this provider. Select to change." : "Select to use a proxy, gateway or another port",
          action: "baseUrl",
        });
      }
    }
    const model = state.model;
    items.push({
      label: model && "problem" in model ? "$(warning) Model" : "$(hubot) Model",
      description: !model
        ? "Looking for models…"
        : "problem" in model
          ? "Not available"
          : `${model.name}${settings.model ? "" : " (recommended)"}`,
      detail: model && "problem" in model ? model.problem : "Select to choose a different model",
      action: "pickModel",
    });
  }
  items.push(
    separator("What is sent"),
    {
      label: "$(file-binary) Message keys and values",
      description: settings.includeMessagePayloads ? "Sent, truncated" : "Not sent",
      detail: settings.includeMessagePayloads ? "Select to stop sending message contents" : "Select to let AI features read message contents (Explain message, Infer schema)",
      action: "togglePayloads",
    },
    {
      label: "$(eye-closed) Broker hostnames",
      description: settings.maskHosts ? "Masked" : "Sent as-is",
      detail: settings.maskHosts ? "Select to send real hostnames" : "Select to replace hostnames with placeholders",
      action: "toggleMaskHosts",
    },
    {
      label: "$(law) Data notice",
      description: state.consented ? "Accepted" : "Not accepted yet",
      detail: "Passwords, SASL usernames, API keys, AWS keys and certificate paths are never sent. Select to review.",
      action: "reviewNotice",
    },
    separator("Actions"),
  );
  if (usable && state.model && !("problem" in state.model)) {
    items.push({ label: "$(comment-discussion) Open Kafka AI chat", detail: "Health checks, lag, topics, configs and connection errors", action: "chat" });
    items.push({ label: "$(play) Test the model", detail: "Send a short prompt and stream the reply to the Kafka AI output", action: "test" });
  }
  items.push(
    {
      label: "$(layout-panel) Ask AI opens",
      description: settings.chatLocation === "panel" ? "Kafka AI panel" : "VS Code Chat view (@kafka)",
      detail: "Select to switch",
      action: "chatLocation",
    },
    { label: "$(output) Show Kafka AI output", action: "showOutput" },
    { label: "$(gear) Open AI settings", action: "openSettings" },
  );
  return items;
}

async function credentialState(provider: ProviderInfo): Promise<CredentialState> {
  if (provider.kind === "vscode") {
    return { kind: "vscode" };
  }
  const key = await resolveKey(provider);
  if (key?.source === "stored") {
    return { kind: "stored", masked: maskKey(key.key) };
  }
  if (key?.source === "env") {
    return { kind: "env", envVar: key.envVar! };
  }
  return provider.auth === "none" ? { kind: "notNeeded" } : { kind: "missing" };
}

/**
 * One picker for everything AI: status, provider, key, model, privacy
 * toggles and a test. Stays open while settings are toggled so the effect is visible.
 */
export async function showAiSetup(state: vscode.Memento): Promise<void> {
  const picker = vscode.window.createQuickPick<SetupItem>();
  picker.title = SETUP_TITLE;
  picker.placeholder = "Use Claude, GPT, Gemini and more with your own API key or sign-in — or your VS Code chat models";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;

  let generation = 0;
  const refresh = async () => {
    const current = ++generation;
    const settings = getAiSettings();
    const view: SetupState = { trusted: vscode.workspace.isTrusted, settings, consented: hasAiConsent(state) };
    const active = picker.activeItems[0]?.action;
    const show = () => {
      picker.items = setupItems(view);
      picker.activeItems = picker.items.filter((i) => i.action === active);
    };
    show();
    if (!view.trusted || !settings.enabled) {
      picker.busy = false;
      return;
    }
    picker.busy = true;
    const resolved = await resolveProvider(settings);
    if (current !== generation) {
      return;
    }
    view.provider = "problem" in resolved ? getProvider(settings.provider) : resolved.provider;
    if (view.provider) {
      view.credential = await credentialState(view.provider);
    }
    const choice = "problem" in resolved ? resolved : await selectModel(settings);
    if (current !== generation) {
      return;
    }
    view.model = "model" in choice ? { name: `${choice.model.name}` } : choice;
    show();
    picker.busy = false;
  };

  const run = (task: () => Thenable<unknown> | Promise<unknown>, reopen = true) => {
    picker.hide();
    void Promise.resolve(task()).then(() => (reopen ? showAiSetup(state) : undefined));
  };

  const subscriptions = [
    vscode.lm.onDidChangeChatModels(() => void refresh()),
    picker.onDidAccept(async () => {
      const action = picker.selectedItems[0]?.action;
      const settings = getAiSettings();
      const provider = picker.selectedItems[0] && (await resolveProvider(settings));
      const current = provider && !("problem" in provider) ? provider.provider : getProvider(settings.provider);
      switch (action) {
        case "toggleEnabled":
          await updateAiSetting("enabled", !settings.enabled);
          break;
        case "togglePayloads":
          await updateAiSetting("includeMessagePayloads", !settings.includeMessagePayloads);
          break;
        case "toggleMaskHosts":
          await updateAiSetting("maskHosts", !settings.maskHosts);
          break;
        case "chatLocation":
          await updateAiSetting("chatLocation", settings.chatLocation === "panel" ? "chatView" : "panel");
          break;
        case "reviewNotice": {
          const model = await selectModel(settings);
          if ("model" in model) {
            await ensureAiConsent(state, model.destination, true);
          } else {
            vscode.window.showInformationMessage("Set up a provider first; the notice names where data is sent.");
          }
          break;
        }
        case "pickProvider":
          return run(() => pickAiProvider());
        case "credentials":
          return current ? run(() => configureCredentials(current)) : undefined;
        case "removeKey":
          return current ? run(() => removeAiKey(current)) : undefined;
        case "baseUrl":
          return current ? run(() => promptBaseUrl(current)) : undefined;
        case "pickModel":
          return run(() => pickAiModel());
        case "chat":
          return run(() => vscode.commands.executeCommand("kafka-manager.askAi"), false);
        case "test":
          return run(() => testAiModel(state), false);
        case "trust":
          return run(() => vscode.commands.executeCommand("workbench.trust.manage"), false);
        case "showOutput":
          return run(async () => aiOutputChannel().show(), false);
        case "openSettings":
          return run(() => vscode.commands.executeCommand("workbench.action.openSettings", "kafka.ai"), false);
        default:
          return;
      }
      void refresh();
    }),
    picker.onDidHide(() => {
      subscriptions.forEach((s) => s.dispose());
      picker.dispose();
    }),
  ];
  picker.show();
  await refresh();
}

const GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: "Sign in with your own account", ids: ["anthropic", "openai", "gemini", "openrouter"] },
  { label: "Through VS Code", ids: ["vscode"] },
  { label: "On this machine", ids: ["ollama", "lmstudio"] },
  { label: "More providers", ids: ["azureOpenai", "mistral", "xai", "deepseek", "groq", "custom"] },
];

/** Lets the user choose a provider for `kafka.ai.provider`, then sets it up. Resolves true when done. */
export async function pickAiProvider(): Promise<boolean> {
  const settings = getAiSettings();
  type Item = vscode.QuickPickItem & { id?: string };
  const items: Item[] = [];
  for (const group of GROUPS) {
    items.push({ label: group.label, kind: vscode.QuickPickItemKind.Separator });
    for (const id of group.ids) {
      const p = getProvider(id)!;
      const key = p.kind === "vscode" ? undefined : await resolveKey(p);
      items.push({
        id,
        label: `${settings.provider === id ? "$(check) " : ""}${p.label}`,
        description: key ? (key.source === "env" ? `$${key.envVar} found` : "key stored") : undefined,
        detail: p.detail,
      });
    }
  }
  items.push(
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      id: "auto",
      label: `${settings.provider === "auto" ? "$(check) " : ""}Auto`,
      detail: "The first provider with a key (Claude, GPT, Gemini, OpenRouter…), else VS Code's chat models",
    },
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: "AI Provider for Kafka Manager",
    placeHolder: "Where should Kafka Manager send AI requests?",
    matchOnDetail: true,
  });
  if (!picked?.id) {
    return false;
  }
  if (picked.id !== settings.provider) {
    await updateAiSetting("provider", picked.id);
    await updateAiSetting("model", undefined);
    if (settings.baseUrl) {
      await updateAiSetting("baseUrl", undefined);
    }
    clearModelCache();
  }
  const provider = getProvider(picked.id);
  if (!provider) {
    return true;
  }
  return configureProvider(provider);
}

/** Endpoint, credentials and model for `provider`, asking only for what is missing. */
export async function configureProvider(provider: ProviderInfo): Promise<boolean> {
  if (provider.needsBaseUrl && !getAiSettings().baseUrl && !(await promptBaseUrl(provider))) {
    return false;
  }
  if (provider.kind === "vscode") {
    const choices = await getModelChoices();
    if ("problem" in choices) {
      const action = await vscode.window.showWarningMessage(choices.problem, "Install GitHub Copilot");
      if (action) {
        void vscode.commands.executeCommand("workbench.extensions.search", "@category:\"AI\" chat");
      }
      return false;
    }
    return pickAiModel();
  }
  const key = await resolveKey(provider);
  if (!key && provider.auth !== "none" && !(await configureCredentials(provider))) {
    return false;
  }
  return pickAiModel();
}

/** Sign-in (OpenRouter) or API key entry for `provider`. Resolves true when a working key is stored. */
export async function configureCredentials(provider: ProviderInfo): Promise<boolean> {
  if (provider.kind === "vscode") {
    void vscode.commands.executeCommand("workbench.action.chat.open");
    return false;
  }
  if (provider.auth === "apiKeyOrOAuth") {
    const how = await vscode.window.showQuickPick(
      [
        { label: "$(globe) Sign in with your browser", detail: "Recommended. Approve Kafka Manager on openrouter.ai; a key is created and stored for you.", oauth: true },
        { label: "$(key) Paste an API key", detail: provider.keyUrl, oauth: false },
      ],
      { title: `Sign in to ${provider.label}` },
    );
    if (!how) {
      return false;
    }
    if (how.oauth) {
      try {
        const ok = await signInToOpenRouter();
        if (ok) {
          vscode.window.showInformationMessage("Signed in to OpenRouter. Kafka AI can now use Claude, GPT, Gemini and other models.");
        }
        return ok;
      } catch (error) {
        vscode.window.showErrorMessage(`OpenRouter sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    }
  }
  return promptApiKey(provider);
}

/** Asks for an API key, checks it against the provider and stores it in secret storage. */
export async function promptApiKey(provider: ProviderInfo): Promise<boolean> {
  const input = vscode.window.createInputBox();
  input.title = `${provider.label} API Key`;
  input.prompt = `Stored in your OS keychain through VS Code's secret storage; never in settings.${provider.keyUrl ? ` Get a key at ${provider.keyUrl}` : ""}`;
  input.password = true;
  input.ignoreFocusOut = true;
  input.placeholder = provider.keyHint ? `${provider.keyHint}…` : "API key";
  const openKey: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("link-external"), tooltip: "Get an API key" };
  if (provider.keyUrl) {
    input.buttons = [openKey];
  }
  const key = await new Promise<string | undefined>((resolve) => {
    input.onDidTriggerButton(() => provider.keyUrl && void vscode.env.openExternal(vscode.Uri.parse(provider.keyUrl)));
    input.onDidChangeValue((v) => (input.validationMessage = v ? keyMismatch(provider, v) : undefined));
    input.onDidAccept(async () => {
      const problem = keyMismatch(provider, input.value);
      if (problem) {
        input.validationMessage = problem;
        return;
      }
      input.busy = true;
      input.enabled = false;
      input.validationMessage = undefined;
      try {
        await listHttpModels(provider, getAiSettings().baseUrl, input.value.trim(), NEVER_CANCELLED);
      } catch (error) {
        input.busy = false;
        input.enabled = true;
        if (error instanceof AiProviderError && (error.kind === "auth" || error.kind === "permission")) {
          input.validationMessage = error.message;
          return;
        }
        // Can't verify (gateway without /models, offline): store it anyway.
      }
      resolve(input.value.trim());
      input.hide();
    });
    input.onDidHide(() => {
      resolve(undefined);
      input.dispose();
    });
    input.show();
  });
  if (!key) {
    return false;
  }
  await storeKey(provider.id, key);
  clearModelCache();
  vscode.window.showInformationMessage(`${provider.label} API key saved.`);
  return true;
}

export async function removeAiKey(provider?: ProviderInfo): Promise<void> {
  let target = provider;
  if (!target) {
    const stored = [];
    for (const p of PROVIDERS) {
      const key = await resolveKey(p);
      if (key?.source === "stored") {
        stored.push({ label: p.label, description: maskKey(key.key), provider: p });
      }
    }
    if (stored.length === 0) {
      vscode.window.showInformationMessage("No AI API keys are stored.");
      return;
    }
    target = (await vscode.window.showQuickPick(stored, { title: "Remove which AI API key?" }))?.provider;
    if (!target) {
      return;
    }
  }
  const ok = await vscode.window.showWarningMessage(`Remove the stored ${target.label} API key?`, { modal: true }, "Remove");
  if (ok === "Remove") {
    await deleteKey(target.id);
    clearModelCache();
  }
}

/** Asks for `kafka.ai.baseUrl`. Resolves true when one was saved. */
export async function promptBaseUrl(provider: ProviderInfo): Promise<boolean> {
  const current = getAiSettings().baseUrl;
  const value = await vscode.window.showInputBox({
    title: `${provider.label} Endpoint`,
    prompt:
      provider.id === "azureOpenai"
        ? "Your resource's OpenAI v1 endpoint, e.g. https://my-resource.openai.azure.com/openai/v1"
        : provider.needsBaseUrl
          ? "Base URL of the OpenAI-compatible API, ending before /chat/completions, e.g. https://gateway.example.com/v1"
          : `Leave empty for the default (${provider.baseUrl})`,
    value: current ?? (provider.needsBaseUrl ? "" : provider.baseUrl),
    ignoreFocusOut: true,
    validateInput: (v) => (!v.trim() ? (provider.needsBaseUrl ? "Enter the endpoint URL" : undefined) : validateBaseUrl(v)),
  });
  if (value === undefined) {
    return false;
  }
  await updateAiSetting("baseUrl", !value.trim() || value.trim() === provider.baseUrl ? undefined : value.trim());
  clearModelCache();
  return true;
}

/** Lets the user pick a model for `kafka.ai.model`. Resolves true if one was chosen. */
export async function pickAiModel(): Promise<boolean> {
  const choices = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Listing AI models…" },
    () => getModelChoices(getAiSettings(), true),
  );
  if ("problem" in choices) {
    const action = await vscode.window.showWarningMessage(choices.problem, OPEN_SETUP);
    if (action === OPEN_SETUP) {
      void vscode.commands.executeCommand("kafka-manager.aiSetup");
    }
    return false;
  }
  const { provider, options } = choices;
  const wanted = getAiSettings().model;
  type Item = vscode.QuickPickItem & { model?: string; custom?: boolean };
  const recommended = options.find((o) => o.recommended);
  const items: Item[] = [
    {
      label: `${wanted ? "" : "$(check) "}Recommended`,
      description: recommended?.name,
      detail: `Follows ${provider.label}'s current recommended model`,
      model: "",
    },
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    ...options.map((o) => ({
      label: `${o.selected ? "$(check) " : ""}${o.name}`,
      description: o.recommended ? "recommended" : o.name !== o.id ? o.id : undefined,
      detail: o.detail,
      model: o.id,
    })),
  ];
  if (provider.kind !== "vscode") {
    items.push({ label: "$(edit) Enter a model id…", detail: "For models the provider doesn't list, e.g. a fine-tune or deployment name", custom: true });
  }
  if (wanted && !options.some((o) => o.selected)) {
    items.splice(2, 0, { label: `$(warning) ${wanted}`, description: "current setting", detail: "Not in the provider's list", model: wanted });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: `${provider.label} Model for Kafka AI`,
    placeHolder: "Which model should Kafka Manager's AI features use?",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return false;
  }
  let model = picked.model;
  if (picked.custom) {
    model = await vscode.window.showInputBox({ title: "Model id", value: wanted ?? "", ignoreFocusOut: true });
    if (model === undefined) {
      return false;
    }
  }
  await updateAiSetting("model", model?.trim() || undefined);
  return true;
}

/** Says which model Kafka AI uses, offering to change it. */
export async function showCurrentAiModel(): Promise<void> {
  const choice = await selectModel();
  if ("problem" in choice) {
    const action = await vscode.window.showWarningMessage(choice.problem, OPEN_SETUP);
    if (action === OPEN_SETUP) {
      void vscode.commands.executeCommand("kafka-manager.aiSetup");
    }
    return;
  }
  const m = choice.model;
  const why = getAiSettings().model ? "set in kafka.ai.model" : "the provider's recommended model";
  const action = await vscode.window.showInformationMessage(
    `Kafka AI uses ${m.name} via ${m.providerLabel} (${choice.destination.where}), ${why}.`,
    "Change Model",
    "Change Provider",
  );
  if (action === "Change Model") {
    await pickAiModel();
  } else if (action === "Change Provider") {
    await pickAiProvider();
  }
}

/** Sends a tiny prompt through the full gate (trust, setting, notice, model) and streams the reply. */
export async function testAiModel(state: vscode.Memento): Promise<void> {
  const choice = await prepareModel(state);
  if ("problem" in choice) {
    const action = await vscode.window.showWarningMessage(choice.problem, OPEN_SETUP);
    if (action === OPEN_SETUP) {
      void showAiSetup(state);
    }
    return;
  }
  const { model } = choice;
  const channel = aiOutputChannel();
  channel.show(true);
  const prompt = "In one short sentence, confirm that you can help explain Apache Kafka cluster problems.";
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Asking ${model.name}…`, cancellable: true },
    async (_progress, token) => {
      channel.appendLine(`── ${new Date().toLocaleTimeString()} · ${model.name} via ${model.providerLabel} (${choice.destination.where}) ──`);
      const reply = await streamModelResponse(
        model,
        { system: "You are a helpful assistant for Apache Kafka.", messages: [userText(prompt)], maxOutputTokens: 200 },
        channelOutput(channel),
        token,
      );
      channel.appendLine("\n");
      if (reply !== undefined && !token.isCancellationRequested) {
        vscode.window.showInformationMessage(`Kafka AI is working with ${model.name} via ${model.providerLabel}.`);
      }
    },
  );
}
