/**
 * The one place prompts are built. `@kafka` in the Chat view, the Kafka AI
 * panel and every "Explain" button go through {@link buildRequest}, so they
 * send the same messages for the same request, and every context section
 * is redacted and fitted to the token budget here.
 */
import { BudgetResult, ContextSection, fitToBudget, TokenCounter } from "./budget";
import { TEMPLATE_VARIABLES } from "../kafka/templates";
import { AiMessage, AiRequest, AiToolSpec, userText } from "./providers/types";
import { redact, RedactOptions } from "./redact";

/** Most context tokens sent per request, however large the model's window. */
export const CONTEXT_BUDGET = 8000;

export type AiTask =
  | "ask"
  | "diagnose"
  | "lag"
  | "explain-error"
  | "topic"
  | "topic-config"
  | "broker-config"
  | "explain-message"
  | "explain-decode-error"
  | "infer-schema"
  | "lag-alert"
  | "dashboard-summary";

/** Tasks with a `/command` in the Chat view. */
export const CHAT_COMMANDS = ["diagnose", "lag", "explain-error", "topic"] as const;
export type ChatCommand = (typeof CHAT_COMMANDS)[number];

export const INSTRUCTIONS = [
  "You are the Kafka Manager assistant inside VS Code. You help with the user's Apache Kafka cluster.",
  "Base your answer on the context below, which Kafka Manager just read from the cluster, and on tool results. If something isn't in it, say so instead of guessing.",
  "Sections marked rule-based are Kafka Manager's own deterministic findings: trust them, explain them and say what to do.",
  "You cannot change the cluster. When an action is needed, name the Kafka Manager command that does it (Reset Group Offsets, Edit Connection Security, Open Cluster Dashboard, Browse Messages, Create Topic, Watch Lag).",
  "Lead with the conclusion. Be concise and use Markdown.",
].join("\n");

export const TASKS: Record<AiTask, string> = {
  ask: "Answer the user's question. Use the Kafka tools when you need data that isn't in the context.",
  diagnose:
    "Give a health check: offline or under-replicated partitions, controller, broker leader skew, consumer groups that are Empty/Dead/rebalancing, and the groups with the most lag. Rank problems by severity; say clearly if everything looks healthy.",
  lag: "Explain this consumer group's lag. Say whether it is one stuck partition, lag spread across all partitions, partitions without a consumer, or an uneven assignment, and what to check next.",
  "explain-error":
    "Explain why connecting to this cluster failed. Give the most likely causes in order, each with concrete steps (Docker advertised.listeners, MSK ports 9092/9094/9096/9098, TLS vs plaintext, SASL mechanism, credentials). Say which Kafka Manager action fixes it (Edit Connection Security, Reconnect).",
  topic:
    "Explain this topic's layout and configuration. Flag risky settings, such as min.insync.replicas >= replication factor, replication factor 1, unbounded retention or leaders piled on one broker.",
  "topic-config":
    "Explain each non-default setting of this topic in plain language, then the rule-based findings: why each matters for durability (acks, min.insync.replicas, replication factor), retention and compaction, and what to change.",
  "broker-config":
    "Explain this broker's notable settings and its role in the cluster (controller, rack, leader and replica load), then the rule-based findings and what to change.",
  "explain-message":
    "Explain this message: its format, its structure and what each field likely means, and anything that could make a consumer fail on it (nulls, types, size, encoding, missing key).",
  "explain-decode-error":
    "Explain why decoding this message with the chosen format failed. Consider a Confluent wire-format magic byte (Avro/Protobuf/JSON Schema via Schema Registry), a UTF-8 BOM, compressed or binary bytes, and the wrong key/value format. Say which format to pick in Kafka Manager or what to configure (Schema Registry).",
  "infer-schema": [
    "From these sample messages, infer the value schema.",
    "Give: 1) a JSON Schema, 2) an equivalent Avro schema, 3) a produce template value for Kafka Manager, as JSON, using these template variables where they fit: " +
      TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(", ") +
      ".",
    "Mark fields that are missing or null in some samples as optional. Put each in its own fenced code block.",
  ].join("\n"),
  "lag-alert":
    "A lag alert fired for this consumer group. Using the rule-based analysis, the lag readings and the group state, explain the most likely cause and the next steps (scale consumers up to the partition count, check the message at the stuck partition's committed offset, restart a hung consumer, or reset offsets if the backlog can be skipped).",
  "dashboard-summary":
    "Write a short health summary of this cluster for its dashboard: one sentence overall verdict, then up to 5 risks ranked by severity, each one line with what to do. No preamble.",
};

export interface PromptInput {
  task: AiTask;
  sections: ContextSection[];
  /** The user's question; may be empty for one-click tasks. */
  question: string;
  /** Earlier turns, oldest first. */
  history?: AiMessage[];
  redaction: RedactOptions;
  /** Context token budget; usually min(CONTEXT_BUDGET, maxInputTokens / 2). */
  budget: number;
  count: TokenCounter;
  tools?: AiToolSpec[];
  maxOutputTokens?: number;
}

export interface BuiltRequest {
  request: AiRequest;
  fitted: BudgetResult;
  /** The sections after redaction, for the panel's data tables. */
  sections: ContextSection[];
}

/** Redacts a section, including its table cells. */
export function redactSection(section: ContextSection, options: RedactOptions): ContextSection {
  return {
    ...section,
    title: redact(section.title, options),
    text: redact(section.text, options),
    table: section.table && {
      columns: section.table.columns,
      rows: section.table.rows.map((row) => row.map((cell) => redact(cell, options))),
    },
  };
}

/** History turns, redacted; tool calls are dropped so old turns stay plain text. */
export function redactHistory(history: AiMessage[], options: RedactOptions, keep = 6): AiMessage[] {
  return history.slice(-keep).flatMap((m) => {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
    return text ? [{ role: m.role, parts: [{ type: "text" as const, text: redact(text, options) }] }] : [];
  });
}

export function budgetFor(maxInputTokens: number): number {
  return Math.max(1000, Math.min(CONTEXT_BUDGET, Math.floor(maxInputTokens / 2)));
}

/** Builds the request for `input`: instructions + task, earlier turns, then context and question. */
export async function buildRequest(input: PromptInput): Promise<BuiltRequest> {
  const safe = input.sections.map((s) => redactSection(s, input.redaction));
  const fitted = await fitToBudget(
    safe.map(({ table: _table, ...rest }) => rest),
    input.budget,
    input.count,
  );
  const question = redact(input.question.trim() || "(no extra question)", input.redaction);
  const request: AiRequest = {
    system: `${INSTRUCTIONS}\n\nTask: ${TASKS[input.task]}`,
    messages: [
      ...redactHistory(input.history ?? [], input.redaction),
      userText(`# Context\n\n${fitted.text || "(none)"}\n\n# Question\n\n${question}`),
    ],
    tools: input.tools?.length ? input.tools : undefined,
    maxOutputTokens: input.maxOutputTokens,
  };
  return { request, fitted, sections: safe };
}
