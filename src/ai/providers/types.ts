/**
 * Provider-neutral chat model types. Every AI feature talks to an `AiModel`;
 * adapters turn it into a VS Code language model, the Anthropic Messages API,
 * the OpenAI Chat Completions API (and compatible servers) or the Gemini API.
 *
 * Nothing here imports `vscode`, so the HTTP providers can be unit-tested and
 * run from a plain Node script (`npm run ai:eval`).
 */

/** The subset of `vscode.CancellationToken` the providers need. */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

export type AiPart =
  | { type: "text"; text: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Opaque provider data that must be sent back with the call (Gemini thought signatures). */
      signature?: string;
    }
  | { type: "toolResult"; id: string; name: string; content: string };

export interface AiMessage {
  role: "user" | "assistant";
  parts: AiPart[];
}

/** JSON Schema for a tool's input; kept to what every provider accepts. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "integer" | "boolean"; description: string; enum?: string[] }>;
  required?: string[];
}

export interface AiToolSpec {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

export interface AiRequest {
  /** Instructions; sent as the system prompt where the provider has one. */
  system: string;
  messages: AiMessage[];
  tools?: AiToolSpec[];
  maxOutputTokens?: number;
}

export type AiStreamEvent =
  | { type: "text"; text: string }
  | { type: "toolCall"; id: string; name: string; input: Record<string, unknown>; signature?: string };

export type ProviderKind = "vscode" | "anthropic" | "openai" | "gemini";

export interface AiModel {
  readonly id: string;
  /** Shown to the user, e.g. "Claude Sonnet 5.5". */
  readonly name: string;
  /** Provider id from the catalog, e.g. "anthropic". */
  readonly provider: string;
  /** Provider name shown to the user, e.g. "Anthropic". */
  readonly providerLabel: string;
  readonly maxInputTokens: number;
  countTokens(text: string, token?: CancellationLike): Promise<number>;
  /** Streams the reply. Throws {@link AiProviderError} on failure. */
  stream(request: AiRequest, token: CancellationLike): AsyncIterable<AiStreamEvent>;
}

export type AiErrorKind =
  | "auth"
  | "permission"
  | "rateLimit"
  | "notFound"
  | "badRequest"
  | "server"
  | "network"
  | "blocked"
  | "cancelled"
  | "other";

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly kind: AiErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export function userText(text: string): AiMessage {
  return { role: "user", parts: [{ type: "text", text }] };
}

export function assistantText(text: string): AiMessage {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

/** The text parts of `message`, joined. */
export function messageText(message: AiMessage): string {
  return message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Rough count (~4 characters a token) for providers without a tokenizer endpoint. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A token that is never cancelled. */
export const NEVER_CANCELLED: CancellationLike = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};
