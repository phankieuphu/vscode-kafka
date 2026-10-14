/** Messages between the Kafka AI panel and its webview, and the pure helpers that build them. */
import { ContextSection } from "./budget";
import { AiTask } from "./prompts";

export interface PanelBlock {
  title: string;
  columns: string[];
  rows: string[][];
}

export interface PanelAction {
  /** Opaque id; the extension keeps the command and arguments, the webview never sees them. */
  id: string;
  title: string;
}

export interface PanelCluster {
  id: string;
  name: string;
  status: string;
}

export type PanelOutMessage =
  | { command: "init"; clusters: PanelCluster[]; clusterId?: string }
  | { command: "clusters"; clusters: PanelCluster[]; clusterId?: string }
  | { command: "model"; label?: string; problem?: string }
  | { command: "user"; id: string; html: string }
  | { command: "assistantStart"; id: string }
  | { command: "assistantUpdate"; id: string; html: string }
  | { command: "progress"; id: string; text: string }
  | { command: "assistantEnd"; id: string; blocks: PanelBlock[]; actions: PanelAction[]; note?: string; error?: boolean }
  | { command: "busy"; value: boolean }
  | { command: "cleared" };

export type PanelInMessage =
  | { command: "ready" }
  | { command: "ask"; text: string }
  | { command: "chip"; task: AiTask }
  | { command: "stop" }
  | { command: "clear" }
  | { command: "selectCluster"; clusterId: string }
  | { command: "action"; id: string }
  | { command: "setup" };

/** Quick actions shown above the input. */
export const CHIPS: ReadonlyArray<{ task: AiTask; label: string; prompt: string }> = [
  { task: "diagnose", label: "Health check", prompt: "Health check" },
  { task: "lag", label: "Explain lag", prompt: "Explain lag" },
  { task: "topic", label: "Explain topic", prompt: "Explain topic" },
  { task: "explain-error", label: "Why did this fail?", prompt: "Why did the connection fail?" },
];

/** Data tables shown next to an answer: the sections that carry one. Sections must already be redacted. */
export function toBlocks(sections: ContextSection[], max = 3): PanelBlock[] {
  return sections
    .filter((s) => s.table && s.table.rows.length > 0)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, max)
    .map((s) => ({ title: s.title, columns: s.table!.columns, rows: s.table!.rows }));
}

/** Validates a message from the webview; anything else is ignored. */
export function parsePanelMessage(value: unknown): PanelInMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const m = value as Record<string, unknown>;
  switch (m.command) {
    case "ready":
    case "stop":
    case "clear":
    case "setup":
      return { command: m.command };
    case "ask":
      return typeof m.text === "string" && m.text.trim() ? { command: "ask", text: m.text.slice(0, 4000) } : undefined;
    case "chip":
      return CHIPS.some((c) => c.task === m.task) ? { command: "chip", task: m.task as AiTask } : undefined;
    case "selectCluster":
    case "action":
      if (typeof (m.clusterId ?? m.id) !== "string") {
        return undefined;
      }
      return m.command === "action" ? { command: "action", id: String(m.id) } : { command: "selectCluster", clusterId: String(m.clusterId) };
    default:
      return undefined;
  }
}
