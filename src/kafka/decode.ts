import { MessageFormat, SchemaInfo } from "./types";

/** What a Schema Registry client must offer to decode Confluent wire-format payloads. */
export interface RegistryDecoder {
  decode(buffer: Buffer): Promise<{ value: unknown; schema: SchemaInfo }>;
}

export interface DecodedField {
  text: string | null;
  /** How `text` was produced, e.g. "utf-8", "json", "avro", "base64". */
  encoding: string;
  schema?: SchemaInfo;
  error?: string;
}

/** Confluent wire format: magic byte 0, then a 4-byte big-endian schema id, then the payload. */
export function schemaIdOf(buffer: Buffer): number | undefined {
  return buffer.length >= 5 && buffer[0] === 0 ? buffer.readUInt32BE(1) : undefined;
}

/** True when `buffer` is valid UTF-8 without control characters other than whitespace. */
export function isPrintableUtf8(buffer: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return false;
  }
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
}

/** JSON text for a decoded record: Buffers become base64, bigints and Longs become strings. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(
    value,
    function (this: unknown, _key, v: unknown) {
      if (typeof v === "bigint") {
        return v.toString();
      }
      if (v && typeof v === "object") {
        const o = v as { type?: unknown; data?: unknown; low?: unknown; high?: unknown; unsigned?: unknown; toString?: () => string };
        // Buffer.toJSON() has already run by the time the replacer sees it.
        if (o.type === "Buffer" && Array.isArray(o.data)) {
          return Buffer.from(o.data as number[]).toString("base64");
        }
        if (typeof o.low === "number" && typeof o.high === "number" && typeof o.unsigned === "boolean" && o.toString) {
          return o.toString();
        }
      }
      return v;
    },
    2,
  );
}

const SCHEMA_FORMATS: Partial<Record<MessageFormat, SchemaInfo["type"]>> = {
  avro: "AVRO",
  protobuf: "PROTOBUF",
  "json-schema": "JSON",
};

/**
 * Turns raw key/value bytes into display text in the requested format.
 * "auto" decodes Confluent wire format through the registry when one is
 * configured, shows printable UTF-8 as text and anything else as base64.
 */
export async function decodeField(
  buffer: Buffer | null,
  format: MessageFormat,
  registry?: RegistryDecoder,
): Promise<DecodedField> {
  if (buffer === null) {
    return { text: null, encoding: "null" };
  }
  switch (format) {
    case "string":
      return { text: buffer.toString("utf8"), encoding: "utf-8" };
    case "hex":
      return { text: buffer.toString("hex"), encoding: "hex" };
    case "base64":
      return { text: buffer.toString("base64"), encoding: "base64" };
    case "json": {
      const text = buffer.toString("utf8");
      try {
        return { text: toJsonText(JSON.parse(text)), encoding: "json" };
      } catch (error) {
        return { text, encoding: "utf-8", error: `Not valid JSON: ${(error as Error).message}` };
      }
    }
    case "avro":
    case "protobuf":
    case "json-schema": {
      const expected = SCHEMA_FORMATS[format]!;
      if (schemaIdOf(buffer) === undefined) {
        return { ...plain(buffer), error: `Not in Schema Registry wire format, so it can't be decoded as ${format}.` };
      }
      return decodeWithRegistry(buffer, registry, expected);
    }
    case "auto":
    default:
      // Binary with a wire-format header: decode it, or say a registry is needed.
      if (schemaIdOf(buffer) !== undefined && !isPrintableUtf8(buffer)) {
        return decodeWithRegistry(buffer, registry);
      }
      return plain(buffer);
  }
}

function plain(buffer: Buffer): DecodedField {
  return isPrintableUtf8(buffer)
    ? { text: buffer.toString("utf8"), encoding: "utf-8" }
    : { text: buffer.toString("base64"), encoding: "base64" };
}

async function decodeWithRegistry(
  buffer: Buffer,
  registry: RegistryDecoder | undefined,
  expected?: SchemaInfo["type"],
): Promise<DecodedField> {
  const id = schemaIdOf(buffer)!;
  if (!registry) {
    return {
      text: buffer.toString("base64"),
      encoding: "base64",
      schema: { id, type: "UNKNOWN" },
      error: "Set a Schema Registry for this cluster to decode it.",
    };
  }
  try {
    const { value, schema } = await registry.decode(buffer);
    if (expected && schema.type !== expected) {
      return { ...plain(buffer), schema, error: `Schema ${id} is ${schema.type}, not ${expected}.` };
    }
    return { text: toJsonText(value), encoding: schema.type.toLowerCase(), schema };
  } catch (error) {
    return {
      text: buffer.toString("base64"),
      encoding: "base64",
      schema: { id, type: "UNKNOWN" },
      error: `Schema Registry decode failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
