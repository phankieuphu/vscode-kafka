import * as vscode from "vscode";
import { ensureAiConsent, getAiSettings, isAiAvailable } from "./settings";

export const NO_MODEL_MESSAGE =
  "No chat model is available. Install or sign in to a chat model provider such as GitHub Copilot.";

/** A model, or why AI can't be used right now (in words fit to show the user). */
export type ModelChoice =
  | { model: vscode.LanguageModelChat }
  | { problem: string };

/** Picks a chat model, honouring `kafka.ai.modelFamily`. Never throws. */
export async function selectModel(): Promise<ModelChoice> {
  const { modelFamily } = getAiSettings();
  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels(modelFamily ? { family: modelFamily } : undefined);
  } catch (error) {
    return { problem: describeModelError(error) };
  }
  if (models.length > 0) {
    return { model: models[0] };
  }
  if (modelFamily) {
    const any = await vscode.lm.selectChatModels().then((m) => m.length > 0, () => false);
    if (any) {
      return {
        problem: `No chat model of family "${modelFamily}" is available. Change or clear the kafka.ai.modelFamily setting.`,
      };
    }
  }
  return { problem: NO_MODEL_MESSAGE };
}

/** One model family the user can choose, as plain data for a picker or webview. */
export interface AiModelOption {
  family: string;
  name: string;
  vendor: string;
  maxInputTokens: number;
  /** `kafka.ai.modelFamily` points at this family. */
  selected: boolean;
  /** What "any available model" resolves to right now. */
  isDefault: boolean;
}

/** The models on offer, with the `kafka.ai.modelFamily` setting; or why there are none. */
export type AiModelChoices =
  | { options: AiModelOption[]; family?: string }
  | { problem: string };

/** Turns available models into one option per family, in provider order, the first being the default. */
export function toModelOptions(
  models: ReadonlyArray<Pick<vscode.LanguageModelChat, "family" | "name" | "vendor" | "maxInputTokens">>,
  family?: string,
): AiModelOption[] {
  const seen = new Set<string>();
  const options: AiModelOption[] = [];
  for (const m of models) {
    if (seen.has(m.family)) {
      continue;
    }
    seen.add(m.family);
    options.push({
      family: m.family,
      name: m.name,
      vendor: m.vendor,
      maxInputTokens: m.maxInputTokens,
      selected: m.family === family,
      isDefault: options.length === 0,
    });
  }
  return options;
}

/** Every chat model the user can pick for Kafka AI. Never throws. */
export async function getModelChoices(): Promise<AiModelChoices> {
  let models: vscode.LanguageModelChat[];
  try {
    models = await vscode.lm.selectChatModels();
  } catch (error) {
    return { problem: describeModelError(error) };
  }
  if (models.length === 0) {
    return { problem: NO_MODEL_MESSAGE };
  }
  const { modelFamily } = getAiSettings();
  return { options: toModelOptions(models, modelFamily), family: modelFamily };
}

/** The model Kafka AI uses right now, as plain data. */
export interface CurrentModel {
  id: string;
  name: string;
  family: string;
  vendor: string;
  maxInputTokens: number;
  /** "setting" when `kafka.ai.modelFamily` picked it, "default" when it is the first available model. */
  source: "setting" | "default";
}

export function toCurrentModel(
  model: Pick<vscode.LanguageModelChat, "id" | "name" | "family" | "vendor" | "maxInputTokens">,
  family?: string,
): CurrentModel {
  return {
    id: model.id,
    name: model.name,
    family: model.family,
    vendor: model.vendor,
    maxInputTokens: model.maxInputTokens,
    source: family && model.family === family ? "setting" : "default",
  };
}

/**
 * The model AI features outside the Chat view use (in the Chat view, `@kafka`
 * follows the chat's model picker unless `kafka.ai.modelFamily` is set). Never throws.
 */
export async function getCurrentModel(): Promise<{ model: CurrentModel } | { problem: string }> {
  const choice = await selectModel();
  if ("problem" in choice) {
    return choice;
  }
  return { model: toCurrentModel(choice.model, getAiSettings().modelFamily) };
}

/**
 * The gate every AI entry point goes through: AI enabled, workspace trusted,
 * the one-time data notice accepted, and a model available.
 */
export async function prepareModel(state: vscode.Memento): Promise<ModelChoice> {
  if (!vscode.workspace.isTrusted) {
    return { problem: "AI features are disabled in untrusted workspaces." };
  }
  if (!isAiAvailable()) {
    return { problem: "AI features are turned off (kafka.ai.enabled)." };
  }
  if (!(await ensureAiConsent(state))) {
    return { problem: "AI features need your OK before any data is sent." };
  }
  return selectModel();
}

export function describeModelError(error: unknown): string {
  if (error instanceof vscode.LanguageModelError) {
    if (error.code === vscode.LanguageModelError.NoPermissions().code) {
      return "Kafka Manager isn't allowed to use the chat model. Allow it when VS Code asks, or check Manage Language Model Access.";
    }
    if (error.code === vscode.LanguageModelError.NotFound().code) {
      return NO_MODEL_MESSAGE;
    }
    if (error.code === vscode.LanguageModelError.Blocked().code) {
      return `The chat model refused the request, possibly because of a rate limit: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
