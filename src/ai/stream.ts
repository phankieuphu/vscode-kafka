import * as vscode from "vscode";
import { describeModelError } from "./model";
import { AiModel, AiRequest, CancellationLike } from "./providers/types";

/** Where a model's answer goes: a chat response, a webview panel, or the Kafka AI output channel. */
export interface AiOutput {
  write(markdown: string): void;
  /** Short status while tools run, e.g. "Reading consumer group orders…". */
  progress?(text: string): void;
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
  return { write: (markdown) => stream.markdown(markdown), progress: (text) => stream.progress(text) };
}

export function channelOutput(target: vscode.OutputChannel = aiOutputChannel()): AiOutput {
  return { write: (text) => target.append(text), progress: (text) => target.appendLine(`\n[${text}]`) };
}

/** Collects the reply in a string; for background use (lag alerts). */
export function bufferOutput(): AiOutput & { text(): string } {
  let text = "";
  return { write: (t) => (text += t), text: () => text };
}

/**
 * Sends `request` to `model` and streams the text reply into `out`. Resolves
 * the full reply; on failure writes a readable error and resolves undefined.
 */
export async function streamModelResponse(
  model: AiModel,
  request: AiRequest,
  out: AiOutput,
  token: CancellationLike,
): Promise<string | undefined> {
  let reply = "";
  try {
    for await (const event of model.stream(request, token)) {
      if (token.isCancellationRequested) {
        break;
      }
      if (event.type === "text") {
        reply += event.text;
        out.write(event.text);
      }
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
