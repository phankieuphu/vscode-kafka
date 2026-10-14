import * as vscode from "vscode";
import { onDidChangeAiKey, resolveKey, ResolvedKey } from "./keys";
import {
  AUTO_ORDER,
  chatModels,
  getProvider,
  ListedModel,
  pickDefaultModel,
  ProviderInfo,
  validateBaseUrl,
} from "./providers/catalog";
import { createHttpModel, effectiveBaseUrl, listHttpModels } from "./providers/httpModel";
import { AiModel, AiProviderError, NEVER_CANCELLED } from "./providers/types";
import { NO_VSCODE_MODEL, wrapVscodeModel } from "./providers/vscodeLm";
import { AiDestination, AiSettings, ensureAiConsent, getAiSettings, isAiAvailable } from "./settings";

export const NO_PROVIDER_MESSAGE =
  "No AI provider is set up. Run Kafka: AI Setup… to add an API key for Claude, GPT or Gemini, sign in with OpenRouter, use a local Ollama model, or use GitHub Copilot.";

/** A model and where it sends data, or why AI can't be used right now (in words fit to show the user). */
export type ModelChoice = { model: AiModel; destination: AiDestination } | { problem: string };

/** The provider `kafka.ai.provider` points at, with its key. */
export type ProviderChoice =
  | { provider: ProviderInfo; key?: ResolvedKey; baseUrl: string }
  | { problem: string };

async function vscodeModels(selector?: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat[]> {
  try {
    return await vscode.lm.selectChatModels(selector);
  } catch {
    return [];
  }
}

/** Which provider to use. "auto" takes the first provider with a key, then VS Code's models. Never throws. */
export async function resolveProvider(settings: AiSettings = getAiSettings()): Promise<ProviderChoice> {
  if (settings.provider === "auto") {
    for (const id of AUTO_ORDER) {
      const provider = getProvider(id)!;
      if (provider.needsBaseUrl && !settings.baseUrl) {
        continue;
      }
      const key = await resolveKey(provider);
      if (key) {
        return { provider, key, baseUrl: effectiveBaseUrl(provider, settings.baseUrl) };
      }
    }
    if ((await vscodeModels()).length > 0) {
      return { provider: getProvider("vscode")!, baseUrl: "" };
    }
    return { problem: NO_PROVIDER_MESSAGE };
  }
  const provider = getProvider(settings.provider);
  if (!provider) {
    return { problem: `Unknown AI provider "${settings.provider}". Pick one in Kafka: AI Setup….` };
  }
  if (provider.kind === "vscode") {
    return { provider, baseUrl: "" };
  }
  const baseUrl = effectiveBaseUrl(provider, settings.baseUrl);
  if (!baseUrl) {
    return { problem: `${provider.label} needs an endpoint URL. Set it in Kafka: AI Setup… (kafka.ai.baseUrl).` };
  }
  const invalid = validateBaseUrl(baseUrl);
  if (invalid) {
    return { problem: `kafka.ai.baseUrl: ${invalid}.` };
  }
  const key = await resolveKey(provider);
  if (!key && (provider.auth === "apiKey" || provider.auth === "apiKeyOrOAuth")) {
    return {
      problem:
        provider.auth === "apiKeyOrOAuth"
          ? `Not signed in to ${provider.label}. Run Kafka: AI Setup… to sign in or add an API key.`
          : `No ${provider.label} API key. Run Kafka: Set AI API Key… (or set ${provider.envVars.join(" / ") || "one in AI Setup"}).`,
    };
  }
  return { provider, key, baseUrl };
}

// ---- Model lists -------------------------------------------------------------

const LIST_TTL_MS = 30 * 60_000;
const listCache = new Map<string, { at: number; models: ListedModel[] }>();

function cacheKey(provider: ProviderInfo, baseUrl: string, key?: ResolvedKey): string {
  return `${provider.id}|${baseUrl}|${key ? key.key.slice(-6) : ""}`;
}

/** The models `provider` offers for this key, cached for half an hour. Throws {@link AiProviderError}. */
export async function listModels(
  provider: ProviderInfo,
  baseUrl: string,
  key: ResolvedKey | undefined,
  options: { refresh?: boolean; token?: vscode.CancellationToken } = {},
): Promise<ListedModel[]> {
  const k = cacheKey(provider, baseUrl, key);
  const cached = listCache.get(k);
  if (cached && !options.refresh && Date.now() - cached.at < LIST_TTL_MS) {
    return cached.models;
  }
  const models = await listHttpModels(provider, baseUrl, key?.key, options.token ?? NEVER_CANCELLED);
  listCache.set(k, { at: Date.now(), models });
  return models;
}

export function clearModelCache(): void {
  listCache.clear();
}

function destinationFor(provider: ProviderInfo, baseUrl: string): AiDestination {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // keep as is
  }
  const local = provider.local || /^(localhost|127\.|\[::1\])/.test(host);
  return { id: `${provider.id}@${host}`, label: provider.label, where: local ? `this machine (${host})` : host, local };
}

/** The model AI features use right now, honouring `kafka.ai.provider` and `kafka.ai.model`. Never throws. */
export async function selectModel(settings: AiSettings = getAiSettings()): Promise<ModelChoice> {
  const choice = await resolveProvider(settings);
  if ("problem" in choice) {
    return choice;
  }
  const { provider, key, baseUrl } = choice;

  if (provider.kind === "vscode") {
    const wanted = settings.model;
    let models = wanted ? await vscodeModels({ family: wanted }) : await vscodeModels();
    if (wanted && models.length === 0) {
      models = await vscodeModels({ id: wanted });
    }
    if (models.length === 0) {
      const any = wanted ? (await vscodeModels()).length > 0 : false;
      return {
        problem: any
          ? `The VS Code chat model "${wanted}" isn't available. Pick another with Kafka: Select AI Model….`
          : NO_VSCODE_MODEL,
      };
    }
    const model = wrapVscodeModel(models[0]);
    return { model, destination: { id: "vscode", label: model.providerLabel, where: "your VS Code chat model provider" } };
  }

  let modelId = settings.model;
  let listed: ListedModel | undefined;
  try {
    const models = await listModels(provider, baseUrl, key);
    modelId ??= pickDefaultModel(provider, models);
    listed = models.find((m) => m.id === modelId);
  } catch (error) {
    // A bad key or an unreachable server is worth saying now rather than on the first request.
    if (error instanceof AiProviderError && (error.kind === "auth" || error.kind === "network")) {
      return { problem: error.message };
    }
    // Some gateways don't implement /models; fall through to the configured or fallback model.
  }
  modelId ??= provider.fallbackModel;
  if (!modelId) {
    return { problem: `Choose a ${provider.label} model with Kafka: Select AI Model… (kafka.ai.model).` };
  }
  const model = createHttpModel({
    provider,
    baseUrl,
    key: key?.key,
    model: modelId,
    displayName: listed?.name,
    maxInputTokens: listed?.maxInputTokens,
    maxOutputTokens: settings.maxOutputTokens,
  });
  return { model, destination: destinationFor(provider, baseUrl) };
}

/** One model the user can pick, as plain data for a picker. */
export interface AiModelOption {
  id: string;
  name: string;
  detail?: string;
  /** `kafka.ai.model` points at it. */
  selected: boolean;
  /** What an empty `kafka.ai.model` resolves to. */
  recommended: boolean;
}

/**
 * Turns VS Code models into one option per family, in provider order, the
 * first being the default. `kafka.ai.model` matches a family or an id.
 */
export function toVscodeModelOptions(
  models: ReadonlyArray<Pick<vscode.LanguageModelChat, "id" | "family" | "name" | "vendor" | "maxInputTokens">>,
  wanted?: string,
): AiModelOption[] {
  const seen = new Set<string>();
  const options: AiModelOption[] = [];
  for (const m of models) {
    if (seen.has(m.family)) {
      continue;
    }
    seen.add(m.family);
    options.push({
      id: m.family,
      name: m.name,
      detail: `${m.vendor} · up to ${m.maxInputTokens.toLocaleString()} input tokens`,
      selected: m.family === wanted || m.id === wanted,
      recommended: options.length === 0,
    });
  }
  return options;
}

/** Listed HTTP models as picker options, the recommended one first. */
export function toHttpModelOptions(provider: ProviderInfo, models: ListedModel[], wanted?: string): AiModelOption[] {
  const recommended = pickDefaultModel(provider, models);
  const options = chatModels(provider, models).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    detail: [m.name && m.name !== m.id ? m.id : "", m.maxInputTokens ? `up to ${m.maxInputTokens.toLocaleString()} input tokens` : ""]
      .filter(Boolean)
      .join(" · ") || undefined,
    selected: m.id === wanted,
    recommended: m.id === recommended,
  }));
  return [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)];
}

/** Every model the current provider offers, or why none can be listed. Never throws. */
export async function getModelChoices(
  settings: AiSettings = getAiSettings(),
  refresh = false,
): Promise<{ provider: ProviderInfo; options: AiModelOption[] } | { problem: string }> {
  const choice = await resolveProvider(settings);
  if ("problem" in choice) {
    return choice;
  }
  const { provider, key, baseUrl } = choice;
  if (provider.kind === "vscode") {
    const models = await vscodeModels();
    return models.length ? { provider, options: toVscodeModelOptions(models, settings.model) } : { problem: NO_VSCODE_MODEL };
  }
  try {
    const models = await listModels(provider, baseUrl, key, { refresh });
    const options = toHttpModelOptions(provider, models, settings.model);
    return options.length ? { provider, options } : { problem: `${provider.label} listed no chat models for this key.` };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The gate every AI entry point goes through: AI enabled, workspace trusted,
 * a model available, and the data notice for its destination accepted.
 */
export async function prepareModel(state: vscode.Memento): Promise<ModelChoice> {
  if (!vscode.workspace.isTrusted) {
    return { problem: "AI features are disabled in untrusted workspaces." };
  }
  if (!isAiAvailable()) {
    return { problem: "AI features are turned off (kafka.ai.enabled)." };
  }
  const choice = await selectModel();
  if ("problem" in choice) {
    return choice;
  }
  if (!(await ensureAiConsent(state, choice.destination))) {
    return { problem: "AI features need your OK before any data is sent." };
  }
  return choice;
}

/**
 * Quick check for showing AI buttons: enabled, trusted and a provider set up.
 * Doesn't contact the provider.
 */
export async function isAiReady(): Promise<boolean> {
  if (!isAiAvailable()) {
    return false;
  }
  return !("problem" in (await resolveProvider()));
}

const availability = new vscode.EventEmitter<void>();
/** Fires when AI may have become usable or unusable: settings, keys, VS Code models, trust. */
export const onDidChangeAiAvailability = availability.event;

export function registerAiAvailability(): vscode.Disposable {
  return vscode.Disposable.from(
    availability,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kafka.ai")) {
        availability.fire();
      }
    }),
    onDidChangeAiKey(() => {
      clearModelCache();
      availability.fire();
    }),
    vscode.lm.onDidChangeChatModels(() => availability.fire()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => availability.fire()),
  );
}

export function describeModelError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
