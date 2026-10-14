import { ProviderInfo, ListedModel } from "./catalog";
import { getJson, parseEventJson, postSse } from "./http";
import { AiMessage, AiProviderError, AiRequest, AiStreamEvent, CancellationLike } from "./types";

export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_OUTPUT = 4096;

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

function toAnthropic(message: AiMessage): { role: "user" | "assistant"; content: AnthropicBlock[] } {
  const content: AnthropicBlock[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim()) {
        content.push({ type: "text", text: part.text });
      }
    } else if (part.type === "toolCall") {
      content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
    } else {
      content.push({ type: "tool_result", tool_use_id: part.id, content: part.content });
    }
  }
  return { role: message.role, content };
}

/** The Messages API request body for `request`. */
export function anthropicBody(model: string, request: AiRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
    system: request.system,
    messages: request.messages.map(toAnthropic).filter((m) => m.content.length > 0),
    stream: true,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  return body;
}

export function anthropicHeaders(key: string | undefined): Record<string, string> {
  return { "anthropic-version": ANTHROPIC_VERSION, ...(key ? { "x-api-key": key } : {}) };
}

/** Turns Messages API stream events into text and complete tool calls. */
export class AnthropicStreamDecoder {
  private readonly tools = new Map<number, { id: string; name: string; json: string }>();

  constructor(private readonly providerLabel = "Anthropic") {}

  push(event: string | undefined, data: string): AiStreamEvent[] {
    const json = parseEventJson(data, this.providerLabel) as Record<string, any>;
    const type = event ?? json.type;
    switch (type) {
      case "content_block_start": {
        const block = json.content_block;
        if (block?.type === "tool_use") {
          this.tools.set(json.index, { id: block.id, name: block.name, json: "" });
        } else if (block?.type === "text" && block.text) {
          return [{ type: "text", text: block.text }];
        }
        return [];
      }
      case "content_block_delta": {
        const delta = json.delta;
        if (delta?.type === "text_delta" && delta.text) {
          return [{ type: "text", text: delta.text }];
        }
        if (delta?.type === "input_json_delta") {
          const tool = this.tools.get(json.index);
          if (tool) {
            tool.json += delta.partial_json ?? "";
          }
        }
        return [];
      }
      case "content_block_stop": {
        const tool = this.tools.get(json.index);
        if (!tool) {
          return [];
        }
        this.tools.delete(json.index);
        let input: Record<string, unknown> = {};
        try {
          input = tool.json ? JSON.parse(tool.json) : {};
        } catch {
          input = {};
        }
        return [{ type: "toolCall", id: tool.id, name: tool.name, input }];
      }
      case "error":
        throw new AiProviderError(
          `${this.providerLabel}: ${json.error?.message ?? "the stream failed"}`,
          json.error?.type === "overloaded_error" ? "server" : json.error?.type === "rate_limit_error" ? "rateLimit" : "other",
        );
      default:
        return [];
    }
  }
}

export async function* anthropicStream(
  provider: ProviderInfo,
  baseUrl: string,
  key: string | undefined,
  model: string,
  request: AiRequest,
  token: CancellationLike,
): AsyncGenerator<AiStreamEvent> {
  const decoder = new AnthropicStreamDecoder(provider.label);
  for await (const event of postSse(`${baseUrl}/v1/messages`, anthropicHeaders(key), anthropicBody(model, request), provider.label, token)) {
    yield* decoder.push(event.event, event.data);
  }
}

export async function anthropicModels(
  provider: ProviderInfo,
  baseUrl: string,
  key: string | undefined,
  token: CancellationLike,
): Promise<ListedModel[]> {
  const json = await getJson<{ data?: Array<{ id: string; display_name?: string; max_input_tokens?: number }> }>(
    `${baseUrl}/v1/models?limit=100`,
    anthropicHeaders(key),
    provider.label,
    token,
  );
  return (json.data ?? []).map((m) => ({ id: m.id, name: m.display_name, maxInputTokens: m.max_input_tokens }));
}
