import { ClusterManager } from "../kafka/clusterManager";
import { AiChatPanel, PanelAsk } from "../panels/aiChatPanel";
import { openKafkaChat } from "./chat";
import { CHAT_COMMANDS } from "./prompts";
import { getAiSettings } from "./settings";

/** The `@kafka` query that asks `ask` in the Chat view, or undefined when only the panel can (extra context). */
export function chatViewQuery(ask: PanelAsk, clusterName?: string): string | undefined {
  if (ask.extraSections?.length) {
    return undefined;
  }
  const command = (CHAT_COMMANDS as readonly string[]).includes(ask.task) ? `/${ask.task}` : ask.task === "ask" ? "" : undefined;
  if (command === undefined) {
    return undefined;
  }
  const subject = ask.target?.group ?? ask.target?.topic ?? "";
  return [command, clusterName, subject, ask.prompt].filter(Boolean).join(" ");
}

/**
 * Asks Kafka AI, in the panel or in the Chat view (`kafka.ai.chatLocation`).
 * Requests that carry extra context (messages, lag readings) always use the panel.
 */
export function openAssistant(manager: ClusterManager, clusterId: string | undefined, ask?: PanelAsk): void {
  const settings = getAiSettings();
  if (settings.chatLocation === "chatView") {
    const name = clusterId ? manager.getCluster(clusterId)?.name : undefined;
    if (!ask) {
      void openKafkaChat(name ? `${name} ` : "");
      return;
    }
    const query = chatViewQuery(ask, name);
    if (query !== undefined) {
      void openKafkaChat(query, true);
      return;
    }
  }
  AiChatPanel.show(manager, clusterId, ask && { ...ask, clusterId: ask.clusterId ?? clusterId });
}
