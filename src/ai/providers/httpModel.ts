import { anthropicModels, anthropicStream } from "./anthropic";
import { ListedModel, normalizeBaseUrl, ProviderInfo } from "./catalog";
import { geminiModels, geminiStream } from "./gemini";
import { openAiModels, openAiStream } from "./openai";
import { AiModel, AiRequest, AiStreamEvent, CancellationLike, estimateTokens } from "./types";

export interface HttpModelOptions {
  provider: ProviderInfo;
  /** `kafka.ai.baseUrl`, or the provider's default. */
  baseUrl?: string;
  key?: string;
  model: string;
  /** From the model list, when known. */
  displayName?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export function effectiveBaseUrl(provider: ProviderInfo, override?: string): string {
  return normalizeBaseUrl(override || provider.baseUrl);
}

/** An {@link AiModel} that talks to a provider's HTTP API directly. */
export function createHttpModel(options: HttpModelOptions): AiModel {
  const { provider, key, model } = options;
  const baseUrl = effectiveBaseUrl(provider, options.baseUrl);
  const stream = (request: AiRequest, token: CancellationLike): AsyncIterable<AiStreamEvent> => {
    const withLimit = { ...request, maxOutputTokens: request.maxOutputTokens ?? options.maxOutputTokens };
    switch (provider.kind) {
      case "anthropic":
        return anthropicStream(provider, baseUrl, key, model, withLimit, token);
      case "gemini":
        return geminiStream(provider, baseUrl, key, model, withLimit, token);
      default:
        return openAiStream(provider, baseUrl, key, model, withLimit, token);
    }
  };
  return {
    id: model,
    name: options.displayName || model,
    provider: provider.id,
    providerLabel: provider.label,
    maxInputTokens: options.maxInputTokens || provider.defaultInputTokens,
    countTokens: async (text) => estimateTokens(text),
    stream,
  };
}

/** Every model the provider lists for this key. */
export function listHttpModels(
  provider: ProviderInfo,
  baseUrlOverride: string | undefined,
  key: string | undefined,
  token: CancellationLike,
): Promise<ListedModel[]> {
  const baseUrl = effectiveBaseUrl(provider, baseUrlOverride);
  switch (provider.kind) {
    case "anthropic":
      return anthropicModels(provider, baseUrl, key, token);
    case "gemini":
      return geminiModels(provider, baseUrl, key, token);
    default:
      return openAiModels(provider, baseUrl, key, token);
  }
}
