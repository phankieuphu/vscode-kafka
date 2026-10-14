import * as vscode from "vscode";
import { ClusterManager } from "../kafka/clusterManager";
import { allStoredKeys } from "./keys";
import { redactionFor } from "./redact";
import { getAiSettings, isAiAvailable } from "./settings";
import { KAFKA_TOOLS, KafkaTool, runTool, ToolEnv } from "./tools";

function env(manager: ClusterManager): ToolEnv {
  const settings = getAiSettings();
  return {
    manager,
    includeMessagePayloads: settings.includeMessagePayloads,
    redaction: async (clusters) => {
      const stored = (await Promise.all(clusters.map((c) => manager.getStoredSecrets(c.id)))).flat();
      return redactionFor(clusters, [...stored, ...(await allStoredKeys())], settings.maskHosts);
    },
  };
}

function languageModelTool(manager: ClusterManager, tool: KafkaTool): vscode.LanguageModelTool<Record<string, unknown>> {
  return {
    prepareInvocation(options) {
      const input = options.input ?? {};
      const where = [input.cluster, input.topic ?? input.group ?? input.brokerId].filter((v) => v !== undefined && v !== "").join(" / ");
      if (tool.readsPayloads) {
        return {
          invocationMessage: `Reading messages${where ? ` from ${where}` : ""}…`,
          confirmationMessages: {
            title: "Read Kafka messages?",
            message: new vscode.MarkdownString(
              `Kafka Manager will read up to ${Math.min(10, Number(input.count ?? 5)) || 5} of the newest messages of **${String(input.topic ?? "the topic")}** and send their keys, headers and (truncated) values to the chat model.`,
            ),
          },
        };
      }
      return { invocationMessage: `${tool.displayName}${where ? `: ${where}` : ""}` };
    },
    async invoke(options, token) {
      const text = isAiAvailable()
        ? await runTool(env(manager), tool.name, options.input ?? {}, token)
        : "Kafka Manager's AI tools are turned off (kafka.ai.enabled), or the workspace isn't trusted.";
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    },
  };
}

/** Registers every read-only Kafka tool with VS Code (`#kafka_*` in agent mode). */
export function registerKafkaTools(manager: ClusterManager): vscode.Disposable {
  if (typeof vscode.lm?.registerTool !== "function") {
    return { dispose: () => undefined };
  }
  return vscode.Disposable.from(...KAFKA_TOOLS.map((tool) => vscode.lm.registerTool(tool.name, languageModelTool(manager, tool))));
}
