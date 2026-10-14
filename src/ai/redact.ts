import { brokerHosts } from "../kafka/connectionConfig";
import { ClusterConfig } from "../kafka/types";

export const REDACTED = "[redacted]";
/** Default cap for one message key or value sent to a model. */
export const MAX_PAYLOAD_CHARS = 2000;

export interface RedactOptions {
  /** Exact values to strip wherever they appear: passwords, usernames, file paths. */
  secrets?: string[];
  /** Hostnames to replace with `host-1`, `host-2`… (when `kafka.ai.maskHosts` is on). */
  hosts?: string[];
}

/** Value after `key=`/`key:` — a quoted string, or up to the next separator. */
const VALUE = String.raw`("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s,;&}\]]+)`;
const KEY_TAIL = String.raw`["']?\s*[=:]\s*`;

/** Keeps a quoted value quoted, so redacted JSON stays JSON. */
const keepQuotes = (_: string, key: string, value: string) =>
  `${key}${/^["']/.test(value) ? `${value[0]}${REDACTED}${value[0]}` : REDACTED}`;

const PATTERNS: Array<[RegExp, string | ((match: string, ...groups: string[]) => string)]> = [
  // Credentials inside URLs (before key=value, which would take `user:`): https://user:pass@registry
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // PEM certificates and private keys pasted inline.
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, `${REDACTED} PEM`],
  // sasl.jaas.config holds `username="…" password="…"`; drop the whole value.
  [new RegExp(String.raw`(sasl\.jaas\.config${KEY_TAIL})("(?:[^"\\\r\n]|\\.)*"|[^\r\n]*)`, "gi"), keepQuotes],
  // key=value / "key": "value" pairs whose key names a credential.
  [
    new RegExp(
      String.raw`([\w.-]*(?:password|passwd|pwd|secret|token|api[_.-]?key|access[_.-]?key|credentials?|user[_.-]?info|user(?:name)?)${KEY_TAIL})${VALUE}`,
      "gi",
    ),
    keepQuotes,
  ],
  [/(\bauthorization["']?\s*[=:]\s*["']?)(?:basic|bearer)\s+[\w.~+/=-]+/gi, `$1${REDACTED}`],
  // AI provider API keys (OpenAI, Anthropic, OpenRouter, Google, Groq, xAI).
  [/\bsk-(?:ant-|or-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\b(?:gsk|xai)[-_][A-Za-z0-9_-]{20,}/g, REDACTED],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, REDACTED],
  // Certificate, key and keystore files. `.key`/`.cert` only with a directory, so `record.key` survives.
  [/[^\s"'`,;()<>=]*\.(?:pem|crt|cer|p12|pfx|jks|keystore|truststore)\b/gi, `${REDACTED} path`],
  [/[^\s"'`,;()<>=]*[\\/][^\s"'`,;()<>=]*\.(?:key|cert)\b/gi, `${REDACTED} path`],
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `value` anywhere; short values only as a whole word, so a 2-character password doesn't eat the text. */
function literal(value: string): RegExp {
  const escaped = escapeRegExp(value);
  return value.length >= 4
    ? new RegExp(escaped, "g")
    : new RegExp(String.raw`(?<![\w.-])${escaped}(?![\w.-])`, "g");
}

/** Strips credentials, key material and (optionally) hostnames from text bound for a model. */
export function redact(text: string, options: RedactOptions = {}): string {
  let out = text;
  const secrets = [...new Set(options.secrets ?? [])]
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    out = out.replace(literal(secret), REDACTED);
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as (match: string, ...groups: string[]) => string);
  }
  const hosts = [...new Set((options.hosts ?? []).map((h) => h.toLowerCase()).filter(Boolean))];
  // Number in first-seen order, but replace longest first so `b-1.x.com` isn't cut by `x.com`.
  const placeholders = new Map(hosts.map((h, i) => [h, `host-${i + 1}`]));
  for (const host of [...hosts].sort((a, b) => b.length - a.length)) {
    out = out.replace(
      new RegExp(String.raw`(?<![\w.-])${escapeRegExp(host)}(?![\w-]|\.\w)`, "gi"),
      placeholders.get(host)!,
    );
  }
  return out;
}

/**
 * Every value of `cluster` that must not reach a model, plus `stored`
 * (its SecretStorage entries: SASL and Schema Registry passwords).
 */
export function clusterSecrets(cluster: ClusterConfig, stored: Array<string | undefined> = []): string[] {
  const values: Array<string | undefined> = [...stored];
  if (cluster.sasl && cluster.sasl.mechanism !== "aws-iam") {
    values.push(cluster.sasl.username);
  }
  if (typeof cluster.ssl === "object") {
    values.push(cluster.ssl.caFile, cluster.ssl.certFile, cluster.ssl.keyFile);
  }
  values.push(cluster.schemaRegistry?.username);
  return values.filter((v): v is string => typeof v === "string" && v.length > 0);
}

/** Broker and Schema Registry hostnames, for masking. */
export function clusterHosts(cluster: ClusterConfig): string[] {
  const hosts = brokerHosts(cluster.brokers).map((b) => b.host);
  if (cluster.schemaRegistry?.url) {
    try {
      hosts.push(new URL(cluster.schemaRegistry.url).hostname.replace(/^\[|\]$/g, ""));
    } catch {
      // Not a URL; nothing to mask.
    }
  }
  return hosts.filter(Boolean);
}

/** Redaction options for text about `clusters`. */
export function redactionFor(
  clusters: ClusterConfig[],
  stored: Array<string | undefined>,
  maskHosts: boolean,
): RedactOptions {
  return {
    secrets: [...stored, ...clusters.flatMap((c) => clusterSecrets(c))].filter(
      (v): v is string => typeof v === "string",
    ),
    hosts: maskHosts ? clusters.flatMap(clusterHosts) : undefined,
  };
}

/** Shortens a message key/value, saying how much was cut. */
export function truncatePayload(text: string, max = MAX_PAYLOAD_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… [${text.length - max} more characters]`;
}
