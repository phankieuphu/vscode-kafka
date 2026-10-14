import * as vscode from "vscode";
import { getCurrentModel, getModelChoices, prepareModel, selectModel } from "./model";
import { AiSettings, ensureAiConsent, getAiSettings, hasAiConsent, updateAiSetting } from "./settings";
import { openKafkaChat } from "./chat";
import { aiOutputChannel, channelOutput, streamModelResponse } from "./stream";

const SETUP_TITLE = "Kafka AI Setup";
const OPEN_SETUP = "AI Setup";

type SetupAction =
  | "trust"
  | "toggleEnabled"
  | "pickModel"
  | "togglePayloads"
  | "toggleMaskHosts"
  | "reviewNotice"
  | "test"
  | "chat"
  | "showOutput"
  | "openSettings";

export interface SetupItem extends vscode.QuickPickItem {
  action?: SetupAction;
}

/** What the setup picker shows. `model` is the resolved model name, or why none is usable; undefined while loading. */
export interface SetupState {
  trusted: boolean;
  settings: AiSettings;
  consented: boolean;
  model?: { name: string } | { problem: string };
}

const separator = (label: string): SetupItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

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
    label: `$(sparkle) AI features`,
    description: settings.enabled ? "On" : "Off",
    detail: settings.enabled ? "Select to turn every AI feature off" : "Select to turn AI features on",
    action: "toggleEnabled",
  });
  const usable = state.trusted && settings.enabled;
  if (usable) {
    const model = state.model;
    items.push({
      label: model && "problem" in model ? "$(warning) Chat model" : "$(hubot) Chat model",
      description: !model
        ? "Looking for models…"
        : "problem" in model
          ? "None available"
          : `${model.name}${settings.modelFamily ? "" : " (any available)"}`,
      detail: model && "problem" in model ? model.problem : "Select to choose a different model",
      action: "pickModel",
    });
  }
  items.push(
    separator("What is sent"),
    {
      label: "$(file-binary) Message keys and values",
      description: settings.includeMessagePayloads ? "Sent, truncated" : "Not sent",
      detail: settings.includeMessagePayloads
        ? "Select to stop sending message contents"
        : "Select to let AI features read message contents",
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
      detail: "Passwords, SASL usernames, AWS keys and certificate paths are never sent. Select to review.",
      action: "reviewNotice",
    },
    separator("Actions"),
  );
  if (usable && state.model && !("problem" in state.model)) {
    items.push({ label: "$(comment-discussion) Ask @kafka in Chat", detail: "Health checks, lag, topics and connection errors", action: "chat" });
    items.push({ label: "$(play) Test the model", detail: "Send a short prompt and stream the reply to the Kafka AI output", action: "test" });
  }
  items.push(
    { label: "$(output) Show Kafka AI output", action: "showOutput" },
    { label: "$(gear) Open AI settings", action: "openSettings" },
  );
  return items;
}

/**
 * One picker for everything AI: status, model, privacy toggles and a test.
 * Stays open while settings are toggled so the effect is visible.
 */
export async function showAiSetup(state: vscode.Memento): Promise<void> {
  const picker = vscode.window.createQuickPick<SetupItem>();
  picker.title = SETUP_TITLE;
  picker.placeholder = "AI features use the chat model you already have in VS Code, such as GitHub Copilot";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;

  let generation = 0;
  const refresh = async () => {
    const current = ++generation;
    const view: SetupState = { trusted: vscode.workspace.isTrusted, settings: getAiSettings(), consented: hasAiConsent(state) };
    picker.items = setupItems(view);
    if (!view.trusted || !view.settings.enabled) {
      picker.busy = false;
      return;
    }
    picker.busy = true;
    const choice = await selectModel();
    if (current !== generation) {
      return;
    }
    view.model = "model" in choice ? { name: choice.model.name } : choice;
    const active = picker.activeItems[0]?.action;
    picker.items = setupItems(view);
    picker.activeItems = picker.items.filter((i) => i.action === active);
    picker.busy = false;
  };

  const subscriptions = [
    vscode.lm.onDidChangeChatModels(() => void refresh()),
    picker.onDidAccept(async () => {
      const action = picker.selectedItems[0]?.action;
      const settings = getAiSettings();
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
        case "reviewNotice":
          await ensureAiConsent(state, true);
          break;
        case "pickModel":
          picker.hide();
          if (await pickAiModel()) {
            void showAiSetup(state);
          }
          return;
        case "chat":
          picker.hide();
          void openKafkaChat();
          return;
        case "test":
          picker.hide();
          void testAiModel(state);
          return;
        case "trust":
          picker.hide();
          void vscode.commands.executeCommand("workbench.trust.manage");
          return;
        case "showOutput":
          picker.hide();
          aiOutputChannel().show();
          return;
        case "openSettings":
          picker.hide();
          void vscode.commands.executeCommand("workbench.action.openSettings", "kafka.ai");
          return;
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

/** Lets the user pick a model family for `kafka.ai.modelFamily`. Resolves true if one was chosen. */
export async function pickAiModel(): Promise<boolean> {
  const choices = await getModelChoices();
  if ("problem" in choices) {
    vscode.window.showWarningMessage(choices.problem);
    return false;
  }
  const { options, family } = choices;
  const items: Array<vscode.QuickPickItem & { family: string }> = [
    {
      label: `${family ? "" : "$(check) "}Any available model`,
      detail: `Currently ${options[0].name}; follows whatever your chat providers offer`,
      family: "",
    },
    ...options.map((o) => ({
      label: `${o.selected ? "$(check) " : ""}${o.name}`,
      description: o.family,
      detail: `${o.vendor} · up to ${o.maxInputTokens.toLocaleString()} input tokens`,
      family: o.family,
    })),
  ];
  if (family && !options.some((o) => o.selected)) {
    items.splice(1, 0, {
      label: `$(warning) ${family}`,
      description: "current setting",
      detail: "Not available right now; pick another model or Any available model",
      family,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: "Chat Model for Kafka AI",
    placeHolder: "Which model should Kafka Manager's AI features use?",
    matchOnDescription: true,
  });
  if (!picked) {
    return false;
  }
  await updateAiSetting("modelFamily", picked.family);
  return true;
}

/** Says which model Kafka AI uses, offering to change it. */
export async function showCurrentAiModel(): Promise<void> {
  const current = await getCurrentModel();
  if ("problem" in current) {
    const action = await vscode.window.showWarningMessage(current.problem, OPEN_SETUP);
    if (action === OPEN_SETUP) {
      void vscode.commands.executeCommand("kafka-manager.aiSetup");
    }
    return;
  }
  const m = current.model;
  const why = m.source === "setting" ? "set in kafka.ai.modelFamily" : "the first available model";
  const action = await vscode.window.showInformationMessage(
    `Kafka AI uses ${m.name} (${m.vendor} · ${m.family}), ${why}. Up to ${m.maxInputTokens.toLocaleString()} input tokens.`,
    "Change Model",
  );
  if (action === "Change Model") {
    await pickAiModel();
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
      const tokens = await Promise.resolve(model.countTokens(prompt, token)).catch(() => undefined);
      channel.appendLine(
        `── ${new Date().toLocaleTimeString()} · ${model.name} (${model.vendor}/${model.family})` +
          `${tokens !== undefined ? ` · prompt ${tokens} of ${model.maxInputTokens.toLocaleString()} tokens` : ""} ──`,
      );
      const reply = await streamModelResponse(
        model,
        [vscode.LanguageModelChatMessage.User(prompt)],
        channelOutput(channel),
        token,
      );
      channel.appendLine("\n");
      if (reply !== undefined && !token.isCancellationRequested) {
        vscode.window.showInformationMessage(`Kafka AI is working with ${model.name}.`);
      }
    },
  );
}
