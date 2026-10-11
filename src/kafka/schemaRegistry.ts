import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { RegistryDecoder, schemaIdOf } from "./decode";
import { SchemaInfo } from "./types";

/**
 * Talks to a Confluent-compatible Schema Registry: decoding/encoding goes
 * through `@kafkajs/confluent-schema-registry` (loaded on first use), while
 * schema metadata (type, subject) comes from the REST API directly, since
 * the library doesn't expose it.
 */
export class SchemaRegistryClient implements RegistryDecoder {
  private library: Promise<SchemaRegistry> | undefined;
  private readonly infos = new Map<number, Promise<SchemaInfo>>();
  private readonly baseUrl: string;

  constructor(
    url: string,
    private readonly username?: string,
    private readonly password?: string,
  ) {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  private registry(): Promise<SchemaRegistry> {
    this.library ??= import("@kafkajs/confluent-schema-registry").then(
      ({ SchemaRegistry }) =>
        new SchemaRegistry({
          host: this.baseUrl,
          clientId: "vscode-kafka",
          retry: { retries: 1 },
          ...(this.username ? { auth: { username: this.username, password: this.password ?? "" } } : {}),
        }),
    );
    return this.library;
  }

  private async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/vnd.schemaregistry.v1+json, application/json" };
    if (this.username) {
      headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password ?? ""}`).toString("base64")}`;
    }
    const response = await fetch(this.baseUrl + path, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Schema Registry ${response.status} ${response.statusText} for ${path}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return (await response.json()) as T;
  }

  /** Type and (when the registry supports the lookup) the first subject for a schema id. */
  schemaInfo(id: number): Promise<SchemaInfo> {
    let info = this.infos.get(id);
    if (!info) {
      info = (async () => {
        const { schemaType } = await this.get<{ schemaType?: string }>(`/schemas/ids/${id}`);
        const type = (schemaType ?? "AVRO").toUpperCase() as SchemaInfo["type"];
        let subject: string | undefined;
        try {
          const versions = await this.get<Array<{ subject: string; version: number }>>(`/schemas/ids/${id}/versions`);
          subject = versions[0] ? `${versions[0].subject} v${versions[0].version}` : undefined;
        } catch {
          // Registries before 5.5 have no reverse lookup; the id alone is still useful.
        }
        return { id, type, subject };
      })();
      info.catch(() => this.infos.delete(id));
      this.infos.set(id, info);
    }
    return info;
  }

  async decode(buffer: Buffer): Promise<{ value: unknown; schema: SchemaInfo }> {
    const id = schemaIdOf(buffer);
    if (id === undefined) {
      throw new Error("Not in Schema Registry wire format");
    }
    const [value, schema] = await Promise.all([
      this.registry().then((r) => r.decode(buffer)),
      this.schemaInfo(id),
    ]);
    return { value, schema };
  }

  /** Encodes `payload` with the latest schema registered under `subject`. */
  async encode(subject: string, payload: unknown): Promise<{ buffer: Buffer; id: number }> {
    const registry = await this.registry();
    const id = await registry.getLatestSchemaId(subject);
    return { buffer: await registry.encode(id, payload), id };
  }

  listSubjects(): Promise<string[]> {
    return this.get<string[]>("/subjects").then((s) => s.slice().sort());
  }
}
