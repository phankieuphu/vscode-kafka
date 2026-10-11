import { usesTls } from "./connectionConfig";
import { ClusterConfig, ConsumedMessage, ProduceOptions } from "./types";

/** One exported message: the fields needed to inspect it or produce it again. */
export interface ExportedMessage {
  partition: number;
  offset: string;
  timestamp: string;
  key: string | null;
  headers: Record<string, string>;
  value: string | null;
}

function toExported(m: ConsumedMessage): ExportedMessage {
  return {
    partition: m.partition,
    offset: m.offset,
    timestamp: m.timestamp,
    key: m.key,
    headers: m.headers,
    value: m.value,
  };
}

export function exportMessages(messages: ConsumedMessage[], format: "json" | "ndjson"): string {
  const records = messages.map(toExported);
  return format === "json"
    ? JSON.stringify(records, null, 2) + "\n"
    : records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
}

/**
 * Reads records to produce from a JSON array or NDJSON file. Each record has
 * a `value` (a string, or any JSON value, which is sent as JSON text) and
 * optional `key`, `headers` and `partition`. Files written by
 * `exportMessages` can be read back as-is; their offsets and timestamps are ignored.
 */
export function parseBatch(text: string): ProduceOptions[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  let records: unknown[];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected a JSON array of records.");
    }
    records = parsed;
  } else {
    records = trimmed.split(/\r?\n/).flatMap((line, i) => {
      if (!line.trim()) {
        return [];
      }
      try {
        return [JSON.parse(line)];
      } catch (error) {
        throw new Error(`Line ${i + 1} isn't valid JSON: ${(error as Error).message}`);
      }
    });
  }
  return records.map((record, i) => toProduceOptions(record, i + 1));
}

function toProduceOptions(record: unknown, n: number): ProduceOptions {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Record ${n} must be an object with a "value".`);
  }
  const r = record as Record<string, unknown>;
  if (!("value" in r)) {
    throw new Error(`Record ${n} has no "value".`);
  }
  const options: ProduceOptions = {
    value: r.value === null ? "" : typeof r.value === "string" ? r.value : JSON.stringify(r.value),
  };
  if (r.key !== undefined && r.key !== null) {
    options.key = typeof r.key === "string" ? r.key : JSON.stringify(r.key);
  }
  if (r.partition !== undefined && r.partition !== null) {
    if (!Number.isInteger(r.partition) || (r.partition as number) < 0) {
      throw new Error(`Record ${n} has an invalid "partition".`);
    }
    options.partition = r.partition as number;
  }
  if (r.headers !== undefined && r.headers !== null) {
    if (typeof r.headers !== "object" || Array.isArray(r.headers)) {
      throw new Error(`Record ${n} "headers" must be an object of strings.`);
    }
    options.headers = Object.fromEntries(
      Object.entries(r.headers as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
  }
  return options;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A kcat command that produces `message` again. Passwords are never included. */
export function kcatProduceCommand(cluster: ClusterConfig, topic: string, message: ConsumedMessage): string {
  const args = ["kcat", "-P", "-b", shellQuote(cluster.brokers.join(",")), "-t", shellQuote(topic), "-p", String(message.partition)];
  const tls = usesTls(cluster);
  const sasl = cluster.sasl;
  if (sasl || tls) {
    args.push("-X", `security.protocol=${sasl ? (tls ? "SASL_SSL" : "SASL_PLAINTEXT") : "SSL"}`);
  }
  if (sasl && sasl.mechanism !== "aws-iam") {
    args.push("-X", `sasl.mechanisms=${sasl.mechanism.toUpperCase()}`, "-X", `sasl.username=${shellQuote(sasl.username)}`, "-X", "sasl.password=\"$KAFKA_PASSWORD\"");
  }
  if (message.key !== null) {
    args.push("-k", shellQuote(message.key));
  }
  for (const [name, value] of Object.entries(message.headers)) {
    args.push("-H", shellQuote(`${name}=${value}`));
  }
  // A file argument is sent as a single message, so multi-line values stay whole.
  return `printf '%s' ${shellQuote(message.value ?? "")} | ${args.join(" ")} /dev/stdin`;
}
