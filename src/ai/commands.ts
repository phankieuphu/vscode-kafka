import * as vscode from "vscode";
import { ClusterManager } from "../kafka/clusterManager";
import { analyzeLag, GroupState } from "../kafka/lagTrend";
import { ClusterConfig } from "../kafka/types";
import { LagMonitor } from "../lagMonitor";
import { AiChatPanel } from "../panels/aiChatPanel";
import { lagTrendContext } from "./context";
import { oneLiner } from "./inline";
import { isAiReady } from "./model";
import { openAssistant } from "./open";
import { getProvider } from "./providers/catalog";
import {
  pickAiModel,
  pickAiProvider,
  promptApiKey,
  removeAiKey,
  showAiSetup,
  showCurrentAiModel,
  testAiModel,
  configureCredentials,
} from "./setup";
import { aiOutputChannel } from "./stream";
import { getAiSettings } from "./settings";

type ClusterArg = { cluster: ClusterConfig } | undefined;
type GroupArg = { cluster: ClusterConfig; group: { groupId: string } };
type TopicArg = { cluster: ClusterConfig; topic: { name: string } };
type BrokerArg = { cluster: ClusterConfig; broker: { nodeId: number } };

/** Pre-analysis of a watched group's lag (rule-based), for the model. */
async function lagAlertSections(manager: ClusterManager, monitor: LagMonitor, cluster: ClusterConfig, groupId: string) {
  const samples = monitor.getHistory(cluster.id, groupId);
  let group: GroupState | undefined;
  try {
    const details = await manager.getGroupDetails(cluster, groupId);
    const assigned = new Set(details.members.flatMap((m) => m.assignment.flatMap((a) => a.partitions.map((p) => `${a.topic}/${p}`))));
    group = { state: details.state, memberCount: details.members.length, assigned };
  } catch {
    group = undefined;
  }
  const { trend, findings } = analyzeLag(samples, group);
  return lagTrendContext(samples, trend, findings);
}

/** The commands behind every AI entry point. */
export function registerAiCommands(context: vscode.ExtensionContext, manager: ClusterManager, monitor: LagMonitor): vscode.Disposable {
  const state = context.globalState;
  AiChatPanel.setState(state);
  const ask = (cluster: ClusterConfig | undefined, task: Parameters<typeof openAssistant>[2]) => openAssistant(manager, cluster?.id, task);
  const currentProvider = () => getProvider(getAiSettings().provider);

  return vscode.Disposable.from(
    vscode.commands.registerCommand("kafka-manager.aiSetup", () => showAiSetup(state)),
    vscode.commands.registerCommand("kafka-manager.selectAiProvider", () => pickAiProvider()),
    vscode.commands.registerCommand("kafka-manager.selectAiModel", () => pickAiModel()),
    vscode.commands.registerCommand("kafka-manager.setAiApiKey", async () => {
      let provider = currentProvider();
      if (!provider || provider.auth === "vscode" || provider.auth === "none") {
        const picked = await vscode.window.showQuickPick(
          ["anthropic", "openai", "gemini", "openrouter", "azureOpenai", "mistral", "xai", "deepseek", "groq", "custom"].map((id) => {
            const p = getProvider(id)!;
            return { label: p.label, detail: p.detail, provider: p };
          }),
          { title: "Set API key for which provider?" },
        );
        provider = picked?.provider;
      }
      if (provider) {
        await (provider.auth === "apiKeyOrOAuth" ? configureCredentials(provider) : promptApiKey(provider));
      }
    }),
    vscode.commands.registerCommand("kafka-manager.removeAiApiKey", () => removeAiKey()),
    vscode.commands.registerCommand("kafka-manager.signInOpenRouter", async () => {
      const ok = await configureCredentials(getProvider("openrouter")!);
      if (ok && getAiSettings().provider !== "openrouter") {
        const use = await vscode.window.showInformationMessage("Use OpenRouter for Kafka AI now?", "Use OpenRouter");
        if (use) {
          await vscode.workspace.getConfiguration("kafka.ai").update("provider", "openrouter", vscode.ConfigurationTarget.Global);
        }
      }
    }),
    vscode.commands.registerCommand("kafka-manager.showAiModel", () => showCurrentAiModel()),
    vscode.commands.registerCommand("kafka-manager.testAi", () => testAiModel(state)),
    vscode.commands.registerCommand("kafka-manager.showAiOutput", () => aiOutputChannel().show()),

    vscode.commands.registerCommand("kafka-manager.askAi", (item?: ClusterArg) => ask(item?.cluster, undefined)),
    vscode.commands.registerCommand("kafka-manager.diagnoseWithAi", (item: ClusterArg) =>
      ask(item?.cluster, { task: "diagnose", prompt: "", label: `Health check${item?.cluster ? ` ${item.cluster.name}` : ""}` }),
    ),
    vscode.commands.registerCommand("kafka-manager.explainErrorWithAi", (item: ClusterArg) =>
      ask(item?.cluster, { task: "explain-error", prompt: "", label: `Why did ${item?.cluster.name ?? "the connection"} fail?` }),
    ),
    vscode.commands.registerCommand("kafka-manager.explainLagWithAi", (item: GroupArg) =>
      ask(item.cluster, { task: "lag", prompt: "", label: `Explain the lag of ${item.group.groupId}`, target: { group: item.group.groupId } }),
    ),
    vscode.commands.registerCommand("kafka-manager.explainTopicWithAi", (item: TopicArg) =>
      ask(item.cluster, { task: "topic", prompt: "", label: `Explain topic ${item.topic.name}`, target: { topic: item.topic.name } }),
    ),
    vscode.commands.registerCommand("kafka-manager.explainBrokerWithAi", (item: BrokerArg) =>
      ask(item.cluster, { task: "broker-config", prompt: "", label: `Explain broker ${item.broker.nodeId}`, target: { brokerId: item.broker.nodeId } }),
    ),
    vscode.commands.registerCommand("kafka-manager.analyzeLag", async (item: GroupArg) => {
      const cluster = manager.getCluster(item.cluster.id) ?? item.cluster;
      const extraSections = await lagAlertSections(manager, monitor, cluster, item.group.groupId);
      AiChatPanel.show(manager, cluster.id, {
        task: "lag-alert",
        prompt: "",
        label: `Why is ${item.group.groupId} lagging?`,
        target: { group: item.group.groupId },
        extraSections,
      });
    }),
  );
}

/** Hooks for the lag monitor: "Analyze" and the optional one-line auto-analysis. */
export function lagAiHooks(context: vscode.ExtensionContext, manager: ClusterManager, monitor: () => LagMonitor) {
  return {
    available: () => isAiReady(),
    summarize: async (cluster: ClusterConfig, group: string) =>
      oneLiner(context.globalState, manager, {
        task: "lag-alert",
        prompt: "What is the most likely cause?",
        clusterId: cluster.id,
        target: { group },
        extraSections: await lagAlertSections(manager, monitor(), cluster, group),
      }),
  };
}
