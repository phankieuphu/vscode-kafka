import { AiMessage, AiModel, AiPart, AiProviderError, AiRequest, CancellationLike } from "./providers/types";
import { AiOutput } from "./stream";

/** Rounds of tool calls before the model must answer. */
export const MAX_TOOL_ROUNDS = 6;

export type ToolRunner = (name: string, input: Record<string, unknown>, token: CancellationLike) => Promise<string>;

export interface AgentResult {
  /** The text the model wrote, across rounds. */
  text: string;
  /** Tools called, in order. */
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  /** Set when the request failed; already written to the output. */
  error?: string;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Human words for a tool call, for progress lines. */
export function toolProgress(name: string, input: Record<string, unknown>): string {
  const what = name.replace(/^kafka_/, "").replace(/([A-Z])/g, " $1").toLowerCase();
  const target = ["topic", "group", "brokerId", "cluster"].map((k) => input[k]).find((v) => v !== undefined && v !== "");
  return `Running ${what}${target !== undefined ? ` (${String(target)})` : ""}…`;
}

/**
 * Streams `request` and, while the model asks for tools, runs them and sends
 * the results back. Text streams into `out` as it arrives. A model that
 * rejects tools gets the request again without them.
 */
export async function runAgent(
  model: AiModel,
  request: AiRequest,
  runTool: ToolRunner,
  out: AiOutput,
  token: CancellationLike,
  maxRounds = MAX_TOOL_ROUNDS,
): Promise<AgentResult> {
  const messages: AiMessage[] = [...request.messages];
  const result: AgentResult = { text: "", toolCalls: [] };
  let toolsRefused = false;

  for (let round = 0; round <= maxRounds; round++) {
    // Last round (or a model that refused tools): no tools, so the model has to answer with what it has.
    const offer = round < maxRounds && !toolsRefused ? request.tools : undefined;
    const calls: Array<Extract<AiPart, { type: "toolCall" }>> = [];
    let text = "";
    try {
      for await (const event of model.stream({ ...request, messages, tools: offer }, token)) {
        if (token.isCancellationRequested) {
          return result;
        }
        if (event.type === "text") {
          text += event.text;
          result.text += event.text;
          out.write(event.text);
        } else {
          calls.push({ type: "toolCall", id: event.id, name: event.name, input: event.input, signature: event.signature });
        }
      }
    } catch (error) {
      if (token.isCancellationRequested) {
        return result;
      }
      // Some models (small local ones, some gateways) refuse tool definitions: retry once without.
      if (offer && round === 0 && !text && error instanceof AiProviderError && error.kind === "badRequest") {
        toolsRefused = true;
        continue;
      }
      result.error = describe(error);
      out.write(`\n\n**Couldn't get an answer:** ${result.error}\n`);
      return result;
    }
    if (calls.length === 0) {
      return result;
    }
    messages.push({ role: "assistant", parts: [...(text ? [{ type: "text" as const, text }] : []), ...calls] });
    const results: AiPart[] = [];
    for (const call of calls) {
      if (token.isCancellationRequested) {
        return result;
      }
      result.toolCalls.push({ name: call.name, input: call.input });
      out.progress?.(toolProgress(call.name, call.input));
      const content = await runTool(call.name, call.input, token);
      results.push({ type: "toolResult", id: call.id, name: call.name, content });
    }
    messages.push({ role: "user", parts: results });
    if (text && !/\s$/.test(text)) {
      out.write("\n\n");
      result.text += "\n\n";
    }
  }
  return result;
}
