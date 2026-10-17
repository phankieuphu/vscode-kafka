import { ListedModel, ProviderInfo } from "./catalog";
import { getJson, parseEventJson, postSse } from "./http";
import { AiMessage, AiProviderError, AiRequest, AiStreamEvent, CancellationLike } from "./types";

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAi(message: AiMessage): OpenAiMessage[] {
  const text = message.parts
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
  if (message.role === "assistant") {
    const calls = message.parts.flatMap((p) =>
      p.type === "toolCall"
        ? [{ id: p.id, type: "function" as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }]
        : [],
    );
    return [{ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  }
  // Tool results are their own messages and must directly follow the assistant's calls.
  const out: OpenAiMessage[] = message.parts.flatMap((p) =>
    p.type === "toolResult" ? [{ role: "tool" as const, tool_call_id: p.id, content: p.content }] : [],
  );
  if (text.trim()) {
    out.push({ role: "user", content: text });
  }
  return out;
}

/** The Chat Completions request body for `request`. */
export function openAiBody(model: string, request: AiRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "system", content: request.system }, ...request.messages.flatMap(toOpenAi)],
    stream: true,
  };
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return body;
}

export function openAiHeaders(provider: ProviderInfo, key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (key) {
    if (provider.keyHeader === "api-key") {
      headers["api-key"] = key;
    } else {
      headers.authorization = `Bearer ${key}`;
    }
  }
  if (provider.id === "openrouter") {
    // App attribution on openrouter.ai.
    headers["HTTP-Referer"] = "https://github.com/phankieuphu/vscode-kafka";
    headers["X-Title"] = "Kafka Manager for VS Code";
  }
  return headers;
}

/** Turns Chat Completions stream chunks into text and complete tool calls. */
export class OpenAiStreamDecoder {
  private readonly calls = new Map<number, { id: string; name: string; args: string }>();

  constructor(private readonly providerLabel = "OpenAI") {}

  /** Events for one `data:` payload. `[DONE]` flushes pending tool calls. */
  push(data: string): AiStreamEvent[] {
    if (data.trim() === "[DONE]") {
      return this.flush();
    }
    const json = parseEventJson(data, this.providerLabel) as Record<string, any>;
    if (json.error) {
      throw new AiProviderError(`${this.providerLabel}: ${json.error.message ?? JSON.stringify(json.error)}`, "other");
    }
    const events: AiStreamEvent[] = [];
    const choice = json.choices?.[0];
    const delta = choice?.delta ?? choice?.message;
    if (typeof delta?.content === "string" && delta.content) {
      events.push({ type: "text", text: delta.content });
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = typeof call.index === "number" ? call.index : this.calls.size;
      const current = this.calls.get(index) ?? { id: "", name: "", args: "" };
      current.id ||= call.id ?? "";
      current.name ||= call.function?.name ?? "";
      current.args += call.function?.arguments ?? "";
      this.calls.set(index, current);
    }
    if (choice?.finish_reason) {
      events.push(...this.flush());
    }
    return events;
  }

  flush(): AiStreamEvent[] {
    const events: AiStreamEvent[] = [];
    for (const [index, call] of [...this.calls].sort((a, b) => a[0] - b[0])) {
      let input: Record<string, unknown> = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = {};
      }
      events.push({ type: "toolCall", id: call.id || `call_${index}`, name: call.name, input });
    }
    this.calls.clear();
    return events;
  }
}

export async function* openAiStream(
  provider: ProviderInfo,
  baseUrl: string,
  key: string | undefined,
  model: string,
  request: AiRequest,
  token: CancellationLike,
): AsyncGenerator<AiStreamEvent> {
  const decoder = new OpenAiStreamDecoder(provider.label);
  for await (const event of postSse(`${baseUrl}/chat/completions`, openAiHeaders(provider, key), openAiBody(model, request), provider.label, token)) {
    yield* decoder.push(event.data);
  }
  yield* decoder.flush();
}

export async function openAiModels(
  provider: ProviderInfo,
  baseUrl: string,
  key: string | undefined,
  token: CancellationLike,
): Promise<ListedModel[]> {
  const json = await getJson<{
    data?: Array<{ id: string; name?: string; created?: number; context_length?: number }>;
  }>(`${baseUrl}/models`, openAiHeaders(provider, key), provider.label, token);
  return (json.data ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    created: m.created,
    maxInputTokens: m.context_length,
  }));
}
