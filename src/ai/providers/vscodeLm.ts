import * as vscode from "vscode";
import { AiMessage, AiModel, AiProviderError, AiRequest, AiStreamEvent, CancellationLike } from "./types";

const JUSTIFICATION = "Explain Kafka cluster state shown in Kafka Manager.";

export const NO_VSCODE_MODEL =
  "No VS Code chat model is available. Install and sign in to a chat model extension such as GitHub Copilot, or pick another provider in Kafka: AI Setup.";

/** Our messages as VS Code chat messages. VS Code has no system role, so the instructions go first as a user turn. */
export function toVscodeMessages(request: AiRequest): vscode.LanguageModelChatMessage[] {
  const out = [vscode.LanguageModelChatMessage.User(request.system)];
  for (const message of request.messages) {
    out.push(toVscodeMessage(message));
  }
  return out;
}

function toVscodeMessage(message: AiMessage): vscode.LanguageModelChatMessage {
  if (message.role === "assistant") {
    const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    for (const p of message.parts) {
      if (p.type === "text" && p.text) {
        parts.push(new vscode.LanguageModelTextPart(p.text));
      } else if (p.type === "toolCall") {
        parts.push(new vscode.LanguageModelToolCallPart(p.id, p.name, p.input));
      }
    }
    return vscode.LanguageModelChatMessage.Assistant(parts);
  }
  const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart> = [];
  for (const p of message.parts) {
    if (p.type === "toolResult") {
      parts.push(new vscode.LanguageModelToolResultPart(p.id, [new vscode.LanguageModelTextPart(p.content)]));
    } else if (p.type === "text" && p.text) {
      parts.push(new vscode.LanguageModelTextPart(p.text));
    }
  }
  return vscode.LanguageModelChatMessage.User(parts);
}

export function describeVscodeModelError(error: unknown): AiProviderError {
  if (error instanceof AiProviderError) {
    return error;
  }
  if (error instanceof vscode.LanguageModelError) {
    if (error.code === vscode.LanguageModelError.NoPermissions().code) {
      return new AiProviderError(
        "Kafka Manager isn't allowed to use this chat model. Allow it when VS Code asks, or check Manage Language Model Access.",
        "permission",
      );
    }
    if (error.code === vscode.LanguageModelError.NotFound().code) {
      return new AiProviderError(NO_VSCODE_MODEL, "notFound");
    }
    if (error.code === vscode.LanguageModelError.Blocked().code) {
      return new AiProviderError(`The chat model refused the request, possibly because of a rate limit: ${error.message}`, "blocked");
    }
  }
  return new AiProviderError(error instanceof Error ? error.message : String(error), "other");
}

/** Wraps a VS Code language model (Copilot or another extension's) as an {@link AiModel}. */
export function wrapVscodeModel(model: vscode.LanguageModelChat): AiModel {
  return {
    id: model.id,
    name: model.name,
    provider: "vscode",
    providerLabel: model.vendor === "copilot" ? "GitHub Copilot" : `VS Code (${model.vendor})`,
    maxInputTokens: model.maxInputTokens,
    countTokens: async (text, token) => {
      try {
        return await model.countTokens(text, token as vscode.CancellationToken | undefined);
      } catch {
        return Math.ceil(text.length / 4);
      }
    },
    stream: (request, token) => streamVscode(model, request, token),
  };
}

async function* streamVscode(
  model: vscode.LanguageModelChat,
  request: AiRequest,
  token: CancellationLike,
): AsyncGenerator<AiStreamEvent> {
  let response: vscode.LanguageModelChatResponse;
  try {
    response = await model.sendRequest(
      toVscodeMessages(request),
      {
        justification: JUSTIFICATION,
        tools: request.tools?.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        toolMode: request.tools?.length ? vscode.LanguageModelChatToolMode.Auto : undefined,
      },
      token as vscode.CancellationToken,
    );
  } catch (error) {
    throw describeVscodeModelError(error);
  }
  try {
    for await (const part of response.stream) {
      if (token.isCancellationRequested) {
        return;
      }
      if (part instanceof vscode.LanguageModelTextPart) {
        if (part.value) {
          yield { type: "text", text: part.value };
        }
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        yield { type: "toolCall", id: part.callId, name: part.name, input: (part.input ?? {}) as Record<string, unknown> };
      }
    }
  } catch (error) {
    if (token.isCancellationRequested) {
      return;
    }
    throw describeVscodeModelError(error);
  }
}
