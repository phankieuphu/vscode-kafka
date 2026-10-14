import { ProviderKind } from "./types";

/** How a provider is signed in to. */
export type ProviderAuth =
  /** An API key, kept in VS Code's secret storage (or read from an environment variable). */
  | "apiKey"
  /** An API key, or a browser sign-in (OAuth PKCE) that creates one. */
  | "apiKeyOrOAuth"
  /** VS Code's own model providers (GitHub Copilot and others); sign-in is handled by VS Code. */
  | "vscode"
  /** A local server; a key is optional. */
  | "none";

export interface ProviderInfo {
  id: string;
  label: string;
  /** One line for pickers. */
  detail: string;
  kind: ProviderKind;
  auth: ProviderAuth;
  /** API root; requests go to `${baseUrl}/…`. Empty when the user must supply one. */
  baseUrl: string;
  /** Header the key is sent in. */
  keyHeader?: "authorization" | "x-api-key" | "x-goog-api-key" | "api-key";
  /** Environment variables checked when no key is stored, in order. */
  envVars: string[];
  /** Where to create a key. */
  keyUrl?: string;
  /** What keys usually look like, to catch a key pasted into the wrong provider. */
  keyPattern?: RegExp;
  /** Used when the model list can't be read. */
  fallbackModel?: string;
  /** The user has to enter the endpoint (Azure, custom gateways). */
  needsBaseUrl?: boolean;
  /** Runs on this machine; data doesn't leave it. */
  local?: boolean;
  /** Context window assumed when the provider doesn't report one. */
  defaultInputTokens: number;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Anthropic Claude",
    detail: "Claude models with an Anthropic API key",
    kind: "anthropic",
    auth: "apiKey",
    baseUrl: "https://api.anthropic.com",
    keyHeader: "x-api-key",
    envVars: ["ANTHROPIC_API_KEY"],
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPattern: /^sk-ant-/,
    fallbackModel: "claude-sonnet-5-5",
    defaultInputTokens: 200_000,
  },
  {
    id: "openai",
    label: "OpenAI GPT",
    detail: "GPT models with an OpenAI API key",
    kind: "openai",
    auth: "apiKey",
    baseUrl: "https://api.openai.com/v1",
    keyHeader: "authorization",
    envVars: ["OPENAI_API_KEY"],
    keyUrl: "https://platform.openai.com/api-keys",
    keyPattern: /^sk-(?!ant-|or-)/,
    fallbackModel: "gpt-5.5",
    defaultInputTokens: 128_000,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    detail: "Gemini models with a Google AI Studio API key (free tier available)",
    kind: "gemini",
    auth: "apiKey",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyHeader: "x-goog-api-key",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyUrl: "https://aistudio.google.com/apikey",
    keyPattern: /^AIza/,
    fallbackModel: "gemini-flash-latest",
    defaultInputTokens: 1_000_000,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    detail: "Sign in with your browser: Claude, GPT, Gemini, Llama, Mistral and more with one account",
    kind: "openai",
    auth: "apiKeyOrOAuth",
    baseUrl: "https://openrouter.ai/api/v1",
    keyHeader: "authorization",
    envVars: ["OPENROUTER_API_KEY"],
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPattern: /^sk-or-/,
    fallbackModel: "anthropic/claude-sonnet-5.5",
    defaultInputTokens: 128_000,
  },
  {
    id: "vscode",
    label: "VS Code language models",
    detail: "GitHub Copilot or any chat model extension, signed in through VS Code",
    kind: "vscode",
    auth: "vscode",
    baseUrl: "",
    envVars: [],
    defaultInputTokens: 64_000,
  },
  {
    id: "azureOpenai",
    label: "Azure OpenAI",
    detail: "Your Azure OpenAI or Azure AI Foundry deployment (OpenAI v1 API)",
    kind: "openai",
    auth: "apiKey",
    baseUrl: "",
    keyHeader: "api-key",
    envVars: ["AZURE_OPENAI_API_KEY"],
    keyUrl: "https://portal.azure.com/",
    needsBaseUrl: true,
    defaultInputTokens: 128_000,
  },
  {
    id: "mistral",
    label: "Mistral AI",
    detail: "Mistral models with a Mistral API key",
    kind: "openai",
    auth: "apiKey",
    baseUrl: "https://api.mistral.ai/v1",
    keyHeader: "authorization",
    envVars: ["MISTRAL_API_KEY"],
    keyUrl: "https://console.mistral.ai/api-keys",
    fallbackModel: "mistral-large-latest",
    defaultInputTokens: 128_000,
  },
  {
    id: "xai",
    label: "xAI Grok",
    detail: "Grok models with an xAI API key",
    kind: "openai",
    auth: "apiKey",
    baseUrl: "https://api.x.ai/v1",
    keyHeader: "authorization",
    envVars: ["XAI_API_KEY"],
    keyUrl: "https://console.x.ai/",
    keyPattern: /^xai-/,
    defaultInputTokens: 128_000,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    detail: "DeepSeek models with a DeepSeek API key",
    kind: "openai",
    auth: "apiKey",
    baseUrl: "https://api.deepseek.com/v1",
    keyHeader: "authorization",
    envVars: ["DEEPSEEK_API_KEY"],
    keyUrl: "https://platform.deepseek.com/api_keys",
    fallbackModel: "deepseek-chat",
    defaultInputTokens: 64_000,
  },
  {
    id: "groq",
    label: "Groq",
    detail: "Fast open models (Llama, Qwen, GPT-OSS…) with a Groq API key",
    kind: "openai",
    auth: "apiKey",
    baseUrl: "https://api.groq.com/openai/v1",
    keyHeader: "authorization",
    envVars: ["GROQ_API_KEY"],
    keyUrl: "https://console.groq.com/keys",
    keyPattern: /^gsk_/,
    defaultInputTokens: 128_000,
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    detail: "Models running on this machine with Ollama; nothing leaves your computer",
    kind: "openai",
    auth: "none",
    baseUrl: "http://localhost:11434/v1",
    keyHeader: "authorization",
    envVars: [],
    local: true,
    defaultInputTokens: 32_000,
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    detail: "Models served by LM Studio on this machine; nothing leaves your computer",
    kind: "openai",
    auth: "none",
    baseUrl: "http://localhost:1234/v1",
    keyHeader: "authorization",
    envVars: [],
    local: true,
    defaultInputTokens: 32_000,
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    detail: "LiteLLM, vLLM, a company gateway or any server with the OpenAI Chat Completions API",
    kind: "openai",
    auth: "none",
    baseUrl: "",
    keyHeader: "authorization",
    envVars: [],
    needsBaseUrl: true,
    defaultInputTokens: 32_000,
  },
];

/** `kafka.ai.provider` values: a catalog id, or "auto". */
export const PROVIDER_IDS = ["auto", ...PROVIDERS.map((p) => p.id)];

/** Order "auto" tries providers with a key in. */
export const AUTO_ORDER = ["anthropic", "openai", "gemini", "openrouter", "azureOpenai", "mistral", "xai", "deepseek", "groq"];

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Strips trailing slashes so `${base}/models` never has `//`. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Problem with a base URL, or undefined. Plain http is only allowed to this machine. */
export function validateBaseUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return "Enter a full URL, e.g. https://my-gateway.example.com/v1";
  }
  if (parsed.protocol === "https:") {
    return undefined;
  }
  if (parsed.protocol === "http:" && isLoopback(parsed.hostname)) {
    return undefined;
  }
  return parsed.protocol === "http:"
    ? "Use https:// (plain http is only allowed for localhost, so API keys aren't sent unencrypted)"
    : "The URL must start with https://";
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127\./.test(host);
}

/** A key that looks like it belongs to another provider, or undefined. */
export function keyMismatch(provider: ProviderInfo, key: string): string | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return "Enter an API key";
  }
  if (/\s/.test(trimmed)) {
    return "An API key has no spaces";
  }
  for (const other of PROVIDERS) {
    if (other.id !== provider.id && other.keyPattern?.test(trimmed) && !provider.keyPattern?.test(trimmed)) {
      return `This looks like a ${other.label} key`;
    }
  }
  return undefined;
}

export interface ListedModel {
  id: string;
  name?: string;
  /** Unix seconds, when the provider reports it. */
  created?: number;
  maxInputTokens?: number;
}

/** Models that can't chat: embeddings, speech, images, moderation and the like. */
const NOT_CHAT = /(embed|embedding|tts|whisper|transcribe|audio|realtime|speech|image|dall-e|moderation|search|similarity|edit|davinci|babbage|guard|rerank|ocr|vision-preview|veo|imagen|lyria|robotics|computer-use|aqa)/i;

function versionScore(id: string): number {
  // Highest dotted/dashed version number in the id: "gemini-3.8-flash" → 3.8, "claude-sonnet-5-5" → 5.5.
  const numbers = [...id.matchAll(/(\d+)(?:[.-](\d{1,2})(?!\d))?/g)]
    .filter((m) => m[1].length <= 2)
    .map((m) => Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0));
  return numbers.length ? Math.max(...numbers) : 0;
}

/** Chat models only, in the order a picker should show them. */
export function chatModels(provider: ProviderInfo, models: ListedModel[]): ListedModel[] {
  const chat = models.filter((m) => !NOT_CHAT.test(m.id));
  if (provider.id === "anthropic" || provider.kind === "gemini") {
    // Both APIs list newest first already.
    return chat;
  }
  if (provider.id === "openai") {
    return chat
      .filter((m) => /^(gpt-|o\d|chatgpt)/i.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
  }
  return chat;
}

/**
 * The model to use when `kafka.ai.model` is empty: a capable, mid-priced
 * current model where the provider has one (Sonnet, a GPT flagship, Gemini
 * Flash), else the first chat model listed.
 */
export function pickDefaultModel(provider: ProviderInfo, models: ListedModel[]): string | undefined {
  const chat = chatModels(provider, models);
  const best = (candidates: ListedModel[]) =>
    [...candidates].sort((a, b) => versionScore(b.id) - versionScore(a.id))[0]?.id;
  switch (provider.id) {
    case "anthropic":
      return best(chat.filter((m) => /sonnet/i.test(m.id))) ?? chat[0]?.id;
    case "openai": {
      const stable = chat.filter((m) => /^gpt-\d/i.test(m.id) && !/(mini|nano|preview|chat|codex|oss|\d{4}-\d{2}-\d{2})/i.test(m.id));
      return best(stable) ?? chat[0]?.id;
    }
    case "gemini": {
      const flash = chat.filter((m) => /^gemini-[\d.]+-flash$/i.test(m.id));
      return best(flash) ?? chat.find((m) => /flash/i.test(m.id) && !/(lite|preview|exp|thinking|live)/i.test(m.id))?.id ?? chat[0]?.id;
    }
    case "openrouter": {
      const sonnet = chat.filter((m) => /^anthropic\/claude-sonnet/i.test(m.id));
      return best(sonnet) ?? chat[0]?.id;
    }
    default:
      return chat[0]?.id;
  }
}
