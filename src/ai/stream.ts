import * as vscode from "vscode";
import { describeModelError } from "./model";

/** Where a model's answer goes: a chat response, or the Kafka AI output channel. */
export interface AiOutput {
  write(markdown: string): void;
}

let channel: vscode.OutputChannel | undefined;

/** The shared "Kafka AI" output channel, created on first use. */
export function aiOutputChannel(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("Kafka AI");
  return channel;
}

export function disposeAiOutputChannel(): void {
  channel?.dispose();
  channel = undefined;
}

export function chatOutput(stream: vscode.ChatResponseStream): AiOutput {
  return { write: (markdown) => stream.markdown(markdown) };
}

export function channelOutput(target: vscode.OutputChannel = aiOutputChannel()): AiOutput {
  return { write: (text) => target.append(text) };
}

/**
 * Sends `messages` to `model` and streams the reply into `out`. Resolves the
 * full reply; on failure writes a readable error and resolves undefined.
 */
export async function streamModelResponse(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  out: AiOutput,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  let reply = "";
  try {
    const response = await model.sendRequest(
      messages,
      { justification: "Explain Kafka cluster state shown in Kafka Manager." },
      token,
    );
    for await (const fragment of response.text) {
      if (token.isCancellationRequested) {
        break;
      }
      reply += fragment;
      out.write(fragment);
    }
    return reply;
  } catch (error) {
    if (token.isCancellationRequested) {
      return reply;
    }
    out.write(`\n\n**Couldn't get an answer:** ${describeModelError(error)}\n`);
    return undefined;
  }
}
