import { ListedModel, ProviderInfo } from "./catalog";
import { getJson, parseEventJson, postSse } from "./http";
import { AiMessage, AiProviderError, AiRequest, AiStreamEvent, CancellationLike, ToolInputSchema } from "./types";

const DEFAULT_MAX_OUTPUT = 4096;

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: { content: string } } };

function toGemini(message: AiMessage): { role: "user" | "model"; parts: GeminiPart[] } {
  const parts: GeminiPart[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text.trim()) {
        parts.push({ text: part.text });
      }
    } else if (part.type === "toolCall") {
      parts.push({
        functionCall: { name: part.name, args: part.input },
        ...(part.signature ? { thoughtSignature: part.signature } : {}),
      });
    } else {
      parts.push({ functionResponse: { name: part.name, response: { content: part.content } } });
    }
  }
  return { role: message.role === "assistant" ? "model" : "user", parts };
}

/** Gemini accepts an OpenAPI subset of JSON Schema; keep only what it knows. */
export function geminiSchema(schema: ToolInputSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    properties[name] = { type: prop.type, description: prop.description, ...(prop.enum ? { enum: prop.enum } : {}) };
  }
  return {
    type: "object",
    properties,
    ...(schema.required?.length ? { required: schema.required } : {}),
  };
}

/** The generateContent request body for `request`. */
export function geminiBody(request: AiRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: request.messages.map(toGemini).filter((c) => c.parts.length > 0),
    generationConfig: { maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT },
  };
  if (request.tools?.length) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          // A tool without inputs must leave parameters out.
          ...(Object.keys(t.inputSchema.properties).length ? { parameters: geminiSchema(t.inputSchema) } : {}),
        })),
      },
    ];
  }
  return body;
}

export function geminiHeaders(key: string | undefined): Record<string, string> {
  return key ? { "x-goog-api-key": key } : {};
}

/** Turns streamGenerateContent chunks into text and tool calls. */
export class GeminiStreamDecoder {
  private calls = 0;

  constructor(private readonly providerLabel = "Gemini") {}

  push(data: string): AiStreamEvent[] {
    const json = parseEventJson(data, this.providerLabel) as Record<string, any>;
    if (json.error) {
      throw new AiProviderError(`${this.providerLabel}: ${json.error.message ?? "the stream failed"}`, "other");
    }
    if (json.promptFeedback?.blockReason) {
      throw new AiProviderError(`${this.providerLabel} blocked the request (${json.promptFeedback.blockReason}).`, "blocked");
    }
    const candidate = json.candidates?.[0];
    const events: AiStreamEvent[] = [];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.thought) {
        continue;
      }
      if (typeof part.text === "string" && part.text) {
        events.push({ type: "text", text: part.text });
      } else if (part.functionCall) {
        events.push({
          type: "toolCall",
          id: part.functionCall.id ?? `gemini-call-${++this.calls}`,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
        });
      }
    }
    if (candidate?.finishReason && /^(SAFETY|RECITATION|BLOCKLIST|PROHIBITED_CONTENT|SPII)$/.test(candidate.finishReason) && events.length === 0) {
      throw new AiProviderError(`${this.providerLabel} stopped the answer (${candidate.finishReason}).`, "blocked");
    }
    return events;
  }
}

function modelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export async function* geminiStream(
  provider: ProviderInfo,
  baseUrl: string,
  key: string | undefined,
  model: string,
  request: AiRequest,
  token: CancellationLike,
): AsyncGenerator<AiStreamEvent> {
  const decoder = new GeminiStreamDecoder(provider.label);
  const url = `${baseUrl}/${modelPath(model)}:streamGenerateContent?alt=sse`;
  for await (const event of postSse(url, geminiHeaders(key), geminiBody(request), provider.label, token)) {
    yield* decoder.push(event.data);
  }
}

export async function geminiModels(
  provider: ProviderInfo,
  baseUrl: string,
  key: string | undefined,
  token: CancellationLike,
): Promise<ListedModel[]> {
  const json = await getJson<{
    models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }>;
  }>(`${baseUrl}/models?pageSize=200`, geminiHeaders(key), provider.label, token);
  return (json.models ?? [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName, maxInputTokens: m.inputTokenLimit }));
}
